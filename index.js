'use strict';

const BbPromise = require('bluebird');

class PrunePlugin {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options || {};
    this.provider = this.serverless.getProvider('aws');

    this.pluginCustom = this.loadCustom(this.serverless.service.custom);

    this.commands = {
      prune: {
        usage: 'Cleans up previously deployed function versions',
        lifecycleEvents: ['prune'],
        options: {
          number: {
            usage: 'Specify the number of previous versions to keep',
            shortcut: 'n',
            required: true
          },
          function: {
            usage: 'Only prune the specified function")',
            shortcut: 'f',
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

      const params = {
        FunctionName: functionName, 
        MaxItems: 200
      };

      return BbPromise.all([
        BbPromise.resolve(functionName),
        this.provider.request('Lambda', 'listVersionsByFunction', params),
        this.provider.request('Lambda', 'listAliases', params)
      ]).catch(e => {
        //ignore if function not deployed
        if (e.statusCode === 404) return [];
        else throw e;
      }).spread((name, versions, aliases) => {
        return { name: name, versions: versions, aliases: aliases };
      });

    }).each(functionResult => {

      if (!functionResult.versions && !functionResult.aliases)
        return BbPromise.resolve();

      const deletionVersions = this.selectPruneVersionsForFunction(
        functionResult.name, functionResult.versions.Versions, functionResult.aliases.Aliases
      );
      return this.deleteVersionsForFunction(functionResult.name, deletionVersions);

    }).then(() => {
      this.serverless.cli.log('Prune: Pruning complete');
    });
  }

  deleteVersionsForFunction(functionName, versions) {
    
    return BbPromise.each(versions, version => {
      
      this.serverless.cli.log(`Prune: Deleting ${functionName} v${version}...`);

      const params = {
        FunctionName: functionName, 
        Qualifier: version
      };
      
      return this.provider.request('Lambda', 'deleteFunction', params)
      .catch(e => {
        //ignore if trying to delete replicated lambda edge function
        if (e.statusCode === 400 && e.message.startsWith('Lambda was unable to delete') && e.message.endsWith('because it is a replicated function.')) this.serverless.cli.log(`Prune: Unable deleting replicated edge function ${functionName} v${version}...`);
        else throw e;
      });
    });
  }

  selectPruneVersionsForFunction(functionName, versions, aliases) {

    const aliasedVersion = aliases.map(a => a.FunctionVersion);

    const deletionCandidates = versions
      .map(f => f.Version)
      .filter(v => v !== '$LATEST') //skip $LATEST
      .filter(v => aliasedVersion.indexOf(v) === -1) //skip aliased versions
      .sort((a, b) => {
        return parseInt(b) - parseInt(a);
      })
      .slice(this.getNumber());

    const puralized = (count, single, plural) => `${count} ${count != 1 ? plural : single}`;
    this.serverless.cli.log(`Prune: ${functionName} has ${puralized(versions.length - 1, 'version', 'versions')} published and ${puralized(aliases.length, 'alias', 'aliases')}, ${puralized(deletionCandidates.length, 'version', 'versions')} selected for deletion`);
  
    return deletionCandidates;
  }

}

module.exports = PrunePlugin;