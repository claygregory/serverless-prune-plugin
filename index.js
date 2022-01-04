'use strict';

const BbPromise = require('bluebird');

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
      return BbPromise.all([
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

    if (this.options.noDeploy === true) {
      return BbPromise.resolve();
    }

    if (this.pluginCustom.automatic &&
      this.pluginCustom.number !== undefined && this.pluginCustom.number >= 0) {

      if(this.pluginCustom.includeLayers) {
        return BbPromise.all([
          this.pruneFunctions(),
          this.pruneLayers()
        ]);
      }

      return this.pruneFunctions();
    } else {
      return BbPromise.resolve();
    }
  }

  pruneLayers() {
    const selectedLayers = this.options.layer ? [this.options.layer] : this.serverless.service.getAllLayers();
    const layerNames = selectedLayers.map(key => this.serverless.service.getLayer(key).name || key);

    this.createProgress(
      'prune-plugin-prune-layers',
      'Pruning layer versions'
    );

    return BbPromise.mapSeries(layerNames, layerName => {

      return BbPromise.join(
        this.listVersionsForLayer(layerName),
        (versions) => ({ name: layerName, versions: versions })
      );

    }).each(({ name, versions }) => {
      if (!versions.length) {
        return BbPromise.resolve();
      }

      const deletionCandidates = this.selectPruneVersionsForLayer(versions);
      if (deletionCandidates.length > 0) {
        this.updateProgress('prune-plugin-prune-layers', `Pruning layer versions (${name})`);
      }

      if (this.options.dryRun) {
        this.printPruningCandidates(name, deletionCandidates);
        return BbPromise.resolve();
      } else {
        return this.deleteVersionsForLayer(name, deletionCandidates);
      }
    }).then(() => {
      this.clearProgress('prune-plugin-prune-layers');
      this.logSuccess('Pruning of layers complete');
    });
  }

  pruneFunctions() {
    const selectedFunctions = this.options.function ? [this.options.function] : this.serverless.service.getAllFunctions();
    const functionNames = selectedFunctions.map(key => this.serverless.service.getFunction(key).name);

    this.createProgress(
      'prune-plugin-prune-functions',
      'Pruning function versions'
    );

    return BbPromise.mapSeries(functionNames, functionName => {

      return BbPromise.join(
        this.listVersionForFunction(functionName),
        this.listAliasesForFunction(functionName),
        (versions, aliases) => ( { name: functionName, versions: versions, aliases: aliases } )
      );

    }).each(({ name, versions, aliases }) => {
      if (!versions.length) {
        return BbPromise.resolve();
      }

      const deletionCandidates = this.selectPruneVersionsForFunction(versions, aliases);
      if (deletionCandidates.length > 0) {
        this.updateProgress('prune-plugin-prune-functions', `Pruning function versions (${name})`);
      }

      if (this.options.dryRun) {
        this.printPruningCandidates(name, deletionCandidates);
        return BbPromise.resolve();
      } else {
        return this.deleteVersionsForFunction(name, deletionCandidates);
      }
    }).then(() => {
      this.clearProgress('prune-plugin-prune-functions');
      this.logSuccess('Pruning of functions complete');
    });
  }

  deleteVersionsForLayer(layerName, versions) {
    return BbPromise.each(versions, version => {
      this.logInfo(`Deleting layer version ${layerName}:${version}.`);

      const params = {
        LayerName: layerName,
        VersionNumber: version
      };

      return BbPromise.resolve()
        .then(() => this.provider.request('Lambda', 'deleteLayerVersion', params))
        .catch(e => {
          throw e;
        });
    });
  }

  deleteVersionsForFunction(functionName, versions) {
    return BbPromise.each(versions, version => {
      this.logInfo(`Deleting function version ${functionName}:${version}.`);

      const params = {
        FunctionName: functionName,
        Qualifier: version
      };

      return BbPromise.resolve()
        .then(() => this.provider.request('Lambda', 'deleteFunction', params))
        .catch(e => {
          //ignore if trying to delete replicated lambda edge function
          if (e.providerError && e.providerError.statusCode === 400
            && e.providerError.message.startsWith('Lambda was unable to delete')
            && e.providerError.message.indexOf('because it is a replicated function.') > -1) {
            this.logWarning(`Unable to delete replicated Lambda@Edge function version ${functionName}:${version}.`);
          } else {
            throw e;
          }
        });
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
        return this.provider.request('Lambda', action, Object.assign({}, params, { Marker: response.NextMarker }))
          .then(responseHandler);
      } else {
        return BbPromise.resolve(results);
      }
    };

    return this.provider.request('Lambda', action, params)
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
