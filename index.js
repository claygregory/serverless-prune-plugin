'use strict';

const { LambdaClient } = require('@aws-sdk/client-lambda');

/**
 * Run an async mapper over `items` with a bounded concurrency limit.
 * Preserves input order in the resolved array. Native Promise only —
 * keeps AWS Lambda API call rate within safe limits while still pruning
 * many versions in parallel instead of one-at-a-time.
 */
async function pMap(items, mapper, concurrency = 5) {
  const results = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const workers = new Array(workerCount).fill(0).map(async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Accept a "deployment skipped" flag regardless of whether it arrives as a
 * boolean (option typed by the framework) or as a string from the CLI.
 */
function isTruthyFlag(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

/**
 * Invoke a Lambda AWS API method in a framework-aware way.
 * osls v4 removed provider.request() (throws AWS_SDK_V2_SURFACE_REMOVED);
 * there a LambdaClient is built from provider.getAwsSdkV3Config() and the
 * matching <Method>Command is sent. On serverless v3 the original
 * provider.request() surface is kept as-is. LambdaClients are cached per
 * provider via a WeakMap.
 */
const lambdaClientPromises = new WeakMap();
function lambdaRequest(provider, action, params) {
  if (typeof provider.getAwsSdkV3Config !== 'function') {
    return provider.request('Lambda', action, params);
  }
  let clientPromise = lambdaClientPromises.get(provider);
  if (!clientPromise) {
    clientPromise = provider.getAwsSdkV3Config().then((cfg) => new LambdaClient(cfg));
    lambdaClientPromises.set(provider, clientPromise);
  }
  return clientPromise.then((client) => {
    // AWS SDK v3 Command classes are PascalCase (e.g. ListVersionsByFunctionCommand),
    // while the v2 provider.request() action names are camelCase (e.g. listVersionsByFunction).
    const commandName = action.charAt(0).toUpperCase() + action.slice(1) + 'Command';
    const Command = require('@aws-sdk/client-lambda')[commandName];
    if (typeof Command !== 'function') {
      throw new Error(
        `Unsupported Lambda action: ${action} (@aws-sdk/client-lambda does not export ${commandName})`
      );
    }
    return client.send(new Command(params));
  });
}

class Prune {
  constructor(serverless, options, { log, progress } = {}) {
    this.serverless = serverless;
    this.options = options || {};
    this.provider = this.serverless.getProvider('aws');
    this.log = log || serverless.cli.log.bind(serverless.cli);
    this.progress = progress;

    this.pluginCustom = this.loadCustom(this.serverless.service.custom);

    this.commands = {
      prune: {
        usage: 'Clean up deployed functions and/or layers by deleting older versions.',
        lifecycleEvents: ['prune'],
        options: {
          number: {
            usage: 'Number of previous versions to keep',
            shortcut: 'n',
            required: true,
            type: 'string'
          },
          stage: {
            usage: 'Stage of the service',
            shortcut: 's',
            type: 'string'
          },
          region: {
            usage: 'Region of the service',
            shortcut: 'r',
            type: 'string'
          },
          function: {
            usage: 'Function name. Limits cleanup to the specified function',
            shortcut: 'f',
            required: false,
            type: 'string'
          },
          layer: {
            usage: 'Layer name. Limits cleanup to the specified Lambda layer',
            shortcut: 'l',
            required: false,
            type: 'string'
          },
          includeLayers: {
            usage: 'Boolean flag. Includes the pruning of Lambda layers.',
            shortcut: 'i',
            required: false,
            type: 'boolean'
          },
          dryRun: {
            usage: 'Simulate pruning without executing delete actions. Deletion candidates are logged when used in conjunction with --verbose',
            shortcut: 'd',
            required: false,
            type: 'boolean'
          },
          verbose: {
            usage: 'Enable detailed output during plugin execution',
            required: false,
            type: 'boolean'
          }
        }
      },
    };

    this.hooks = {
      'prune:prune': this.cliPrune.bind(this),
      'after:deploy:deploy': this.postDeploy.bind(this)
    };
  }

  getNumber() {
    return this.options.number || this.pluginCustom.number;
  }

  loadCustom(custom) {
    const pluginCustom = {};
    if (custom && custom.prune) {

      if (custom.prune.number != null) {
        const number = parseInt(custom.prune.number);
        if (!isNaN(number)) pluginCustom.number = number;
      }

      if (typeof custom.prune.automatic === 'boolean') {
        pluginCustom.automatic = custom.prune.automatic;
      }

      if (typeof custom.prune.includeLayers === 'boolean') {
        pluginCustom.includeLayers = custom.prune.includeLayers;
      }
    }

    return pluginCustom;
  }

  cliPrune() {
    if (this.options.dryRun) {
      this.logNotice('Dry-run enabled, no pruning actions will be performed.');
    }

    if(this.options.includeLayers) {
      return Promise.all([
        this.pruneFunctions(),
        this.pruneLayers()
      ]);
    }

    if (this.options.layer && !this.options.function) {
      return this.pruneLayers();
    } else {
      return this.pruneFunctions();
    }
  }

  postDeploy() {
    this.pluginCustom = this.loadCustom(this.serverless.service.custom);

    if (isTruthyFlag(this.options.noDeploy)) {
      // Deployment was skipped — do not prune.
      this.logNotice('Deployment skipped (noDeploy). Skipping prune.');
      return Promise.resolve();
    }

    if (this.pluginCustom.automatic &&
      this.pluginCustom.number !== undefined && this.pluginCustom.number >= 0) {

      if(this.pluginCustom.includeLayers) {
        return Promise.all([
          this.pruneFunctions(),
          this.pruneLayers()
        ]);
      }

      return this.pruneFunctions();
    } else {
      return Promise.resolve();
    }
  }

  async pruneLayers() {
    const selectedLayers = this.options.layer ? [this.options.layer] : this.serverless.service.getAllLayers();
    const layerNames = selectedLayers.map(key => this.serverless.service.getLayer(key).name || key);

    this.createProgress(
      'prune-plugin-prune-layers',
      'Pruning layer versions'
    );

    for (const layerName of layerNames) {
      const versions = await this.listVersionsForLayer(layerName);
      if (!versions.length) {
        continue;
      }

      const deletionCandidates = this.selectPruneVersionsForLayer(versions);
      if (deletionCandidates.length > 0) {
        this.updateProgress('prune-plugin-prune-layers', `Pruning layer versions (${layerName})`);
      }

      if (this.options.dryRun) {
        this.printPruningCandidates(layerName, deletionCandidates);
      } else {
        await this.deleteVersionsForLayer(layerName, deletionCandidates);
      }
    }

    this.clearProgress('prune-plugin-prune-layers');
    this.logSuccess('Pruning of layers complete');
  }

  async pruneFunctions() {
    const selectedFunctions = this.options.function ? [this.options.function] : this.serverless.service.getAllFunctions();
    const functionNames = selectedFunctions.map(key => this.serverless.service.getFunction(key).name);

    this.createProgress(
      'prune-plugin-prune-functions',
      'Pruning function versions'
    );

    for (const functionName of functionNames) {
      const [versions, aliases] = await Promise.all([
        this.listVersionForFunction(functionName),
        this.listAliasesForFunction(functionName)
      ]);
      if (!versions.length) {
        continue;
      }

      const deletionCandidates = this.selectPruneVersionsForFunction(versions, aliases);
      if (deletionCandidates.length > 0) {
        this.updateProgress('prune-plugin-prune-functions', `Pruning function versions (${functionName})`);
      }

      if (this.options.dryRun) {
        this.printPruningCandidates(functionName, deletionCandidates);
      } else {
        await this.deleteVersionsForFunction(functionName, deletionCandidates);
      }
    }

    this.clearProgress('prune-plugin-prune-functions');
    this.logSuccess('Pruning of functions complete');
  }

  deleteVersionsForLayer(layerName, versions) {
    return pMap(versions, async (version) => {
      this.logInfo(`Deleting layer version ${layerName}:${version}.`);
      const params = {
        LayerName: layerName,
        VersionNumber: version
      };
      await lambdaRequest(this.provider, 'deleteLayerVersion', params);
    });
  }

  deleteVersionsForFunction(functionName, versions) {
    return pMap(versions, async (version) => {
      this.logInfo(`Deleting function version ${functionName}:${version}.`);
      const params = {
        FunctionName: functionName,
        Qualifier: version
      };
      try {
        await lambdaRequest(this.provider, 'deleteFunction', params);
      } catch (e) {
        //ignore if trying to delete replicated lambda edge function.
        //Works for serverless v3 (provider.request: e.providerError) and
        //osls v4 / AWS SDK v3 (e.$metadata + e.message).
        const httpStatus = (e.providerError && e.providerError.statusCode) || (e.$metadata && e.$metadata.httpStatusCode);
        const message = (e.providerError && e.providerError.message) || e.message;
        if (httpStatus === 400
          && message
          && message.startsWith('Lambda was unable to delete')
          && message.indexOf('because it is a replicated function.') > -1) {
          this.logWarning(`Unable to delete replicated Lambda@Edge function version ${functionName}:${version}.`);
        } else {
          throw e;
        }
      }
    });
  }

  listAliasesForFunction(functionName) {
    const params = {
      FunctionName: functionName
    };

    return this.makeLambdaRequest('listAliases', params, r => r.Aliases)
      .catch(e => {
        //ignore if function not deployed
        if (e.providerError && e.providerError.statusCode === 404) return [];
        else throw e;
      });
  }

  listVersionForFunction(functionName) {
    const params = {
      FunctionName: functionName
    };

    return this.makeLambdaRequest('listVersionsByFunction', params, r => r.Versions)
      .catch(e => {
        //ignore if function not deployed
        if (e.providerError && e.providerError.statusCode === 404) return [];
        else throw e;
      });
  }

  listVersionsForLayer(layerName) {
    const params = {
      LayerName: layerName
    };

    return this.makeLambdaRequest('listLayerVersions', params, r => r.LayerVersions)
      .catch(e => {
        // ignore if layer not deployed
        if (e.providerError && e.providerError.statusCode === 404) return [];
        else throw e;
      });

  }

  makeLambdaRequest(action, params, responseMapping) {
    const results = [];
    const responseHandler = response => {
      Array.prototype.push.apply(results, responseMapping(response));

      if (response.NextMarker) {
        return lambdaRequest(this.provider,action, Object.assign({}, params, { Marker: response.NextMarker }))
          .then(responseHandler);
      } else {
        return Promise.resolve(results);
      }
    };

    return lambdaRequest(this.provider,action, params)
      .then(responseHandler);
  }

  selectPruneVersionsForFunction(versions, aliases) {
    const aliasedVersion = aliases.map(a => a.FunctionVersion);

    return versions
      .map(f => f.Version)
      .filter(v => v !== '$LATEST') //skip $LATEST
      .filter(v => aliasedVersion.indexOf(v) === -1) //skip aliased versions
      .sort((a, b) => parseInt(a) === parseInt(b) ? 0 : parseInt(a) > parseInt(b) ? -1 : 1)
      .slice(this.getNumber());
  }

  selectPruneVersionsForLayer(versions) {
    return versions
      .map(f => f.Version)
      .sort((a, b) => parseInt(a) === parseInt(b) ? 0 : parseInt(a) > parseInt(b) ? -1 : 1)
      .slice(this.getNumber());
  }

  printPruningCandidates(name, deletionCandidates) {
    deletionCandidates.forEach(version => this.logInfo(`${name}:${version} selected for deletion.`));
  }

  // -- Compatibility with both Framework 2.x and 3.x logging ---

  logInfo(message) {
    if (this.log.info) this.log.info(message);
    else this.log(`Prune: ${message}`);
  }

  logNotice(message) {
    if (this.log.notice) this.log.notice(message);
    else this.log(`Prune: ${message}`);
  }

  logWarning(message) {
    if (this.log.warning) this.log.warning(message);
    else this.log(`Prune: ${message}`);
  }

  logSuccess(message) {
    if (this.log.success) this.log.success(message);
    else this.log(`Prune: ${message}`);
  }

  createProgress(name, message) {
    if (!this.progress) {
      this.log(`Prune: ${message}...`);
    } else {
      this.progress.create({
        message,
        name
      });
    }
  }

  updateProgress(name, message) {
    if (!this.progress) {
      this.log(`Prune: ${message}`);
    } else {
      this.progress.get(name).update(message);
    }
  }

  clearProgress(name) {
    if (this.progress) {
      this.progress.get(name).remove();
    }
  }
}

module.exports = Prune;
