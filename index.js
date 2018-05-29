'use strict';

const BbPromise = require('bluebird');

class Prune {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options || {};
    this.provider = this.serverless.getProvider('aws');

    this.pluginCustom = this.loadCustom(this.serverless.service.custom);

    this.commands = {
      prune: {
        usage: 'Clean up deployed functions by deleting older versions.',
        lifecycleEvents: ['prune'],
        options: {
          number: {
            usage: 'Number of previous versions to keep',
            shortcut: 'n',
            required: true
          },
          stage: {
            usage: 'Stage of the service',
            shortcut: 's',
          },
          region: {
            usage: 'Region of the service',
            shortcut: 'r',
          },
          function: {
            usage: 'Function name. Limits cleanup to the specified function',
            shortcut: 'f',
            required: false
          },
          dryRun: {
            usage: 'Dry-run. Lists deletion candidates',
            shortcut: 'd',
            required: false
          }
        }
      },
    };

    this.hooks = {
      'prune:prune': this.prune.bind(this),
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

      if (custom.prune.automatic != null && typeof custom.prune.automatic === 'boolean') {
        pluginCustom.automatic = custom.prune.automatic;
      }

    }

    return pluginCustom;
  }

  postDeploy() {
    this.pluginCustom = this.loadCustom(this.serverless.service.custom);

    if (this.options.noDeploy === true) {
      return BbPromise.resolve();
    }

    if (this.pluginCustom.automatic && this.pluginCustom.number >= 1) {
      this.serverless.cli.log('Prune: Running post-deployment pruning');
      return this.prune();
    } else {
      return BbPromise.resolve();
    }
  }

  prune() {

    const selectedFunctions = this.options.function ? [this.options.function] : this.serverless.service.getAllFunctions();
    const functionNames = selectedFunctions.map(key => this.serverless.service.getFunction(key).name);

    this.serverless.cli.log('Prune: Querying for deployed versions');

    return BbPromise.mapSeries(functionNames, functionName => {

      return BbPromise.join(
        this.listVersionForFunction(functionName),
        this.listAliasesForFunction(functionName),
        (versions, aliases) => ( { name: functionName, versions: versions, aliases: aliases } )
      );

    }).each(functionResult => {

      if (!functionResult.versions.length)
        return BbPromise.resolve();

      const deletionVersions = this.selectPruneVersionsForFunction(functionResult.versions, functionResult.aliases);

      const puralized = (count, single, plural) => `${count} ${count != 1 ? plural : single}`;

      const nonLatestVersionCount = functionResult.versions.length - 1;
      const aliasCount = functionResult.aliases.length;
      this.serverless.cli.log(`Prune: ${functionResult.name} has ${puralized(nonLatestVersionCount, 'additional version', 'additional versions')} published and ${puralized(aliasCount, 'alias', 'aliases')}, ${puralized(deletionVersions.length, 'version', 'versions')} selected for deletion`);
  
      if (this.options.dryRun) {
        return BbPromise.resolve();
      } else {
        return this.deleteVersionsForFunction(functionResult.name, deletionVersions);
      }

    }).then(() => {
      const actions = this.options.dryRun ? 'Dry-run complete, no actions taken.' : 'Pruning complete.';
      this.serverless.cli.log('Prune: ' + actions);
    });
  }

  deleteVersionsForFunction(functionName, versions) {
    
    return BbPromise.each(versions, version => {
      
      this.serverless.cli.log(`Prune: Deleting ${functionName} v${version}...`);

      const params = {
        FunctionName: functionName, 
        Qualifier: version
      };
      
      return BbPromise.resolve()
        .then(() => this.provider.request('Lambda', 'deleteFunction', params))
        .catch(e => {
          //ignore if trying to delete replicated lambda edge function
          if (e.statusCode === 400 && e.message.startsWith('Lambda was unable to delete') && e.message.endsWith('because it is a replicated function.')) this.serverless.cli.log(`Prune: Unable to delete replicated edge function ${functionName} v${version}...`);
          else throw e;
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
        if (e.statusCode === 404) return [];
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
        if (e.statusCode === 404) return [];
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

    const deletionCandidates = versions
      .map(f => f.Version)
      .filter(v => v !== '$LATEST') //skip $LATEST
      .filter(v => aliasedVersion.indexOf(v) === -1) //skip aliased versions
      .sort((a, b) => parseInt(b) - parseInt(a))
      .slice(this.getNumber());

    return deletionCandidates;
  }

}

module.exports = Prune;