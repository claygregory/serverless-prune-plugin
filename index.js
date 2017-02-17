'use strict';

const BbPromise = require('bluebird');

class PrunePlugin {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options || {};
    this.provider = this.serverless.getProvider('aws');

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
      'prune:prune': this.prune.bind(this)
    };
  }

  prune() {

    const selectedFunctions = this.options.function ? [this.options.function] : this.serverless.service.getAllFunctions();
    const functionNames = selectedFunctions.map(key => this.serverless.service.getFunction(key).name);

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
      });

    }).each(([name, versions, aliases]) => {

      if (!versions && !aliases)
        return BbPromise.resolve();

      const deletionVersions = this.selectPruneVersionsForFunction(name, versions.Versions, aliases.Aliases);
      return this.deleteVersionsForFunction(name, deletionVersions);

    }).then(() => {
      this.serverless.cli.log('Pruning complete');
    });
  }

  deleteVersionsForFunction(functionName, versions) {
    
    return BbPromise.each(versions, version => {
      
      this.serverless.cli.log(`Deleting ${functionName} v${version}...`);

      const params = {
        FunctionName: functionName, 
        Qualifier: version
      };
      
      return this.provider.request('Lambda', 'deleteFunction', params);
    });
  }

  selectPruneVersionsForFunction(functionName, versions, aliases) {

    const aliasedVersion = aliases.map(a => a.FunctionVersion);

    const deletionCandidates = versions
      .map(f => f.Version)
      .filter(v => v !== '$LATEST')
      .filter(v => !aliasedVersion.includes(v))
      .sort((a, b) => {
        return parseInt(b) - parseInt(a);
      })
      .slice(this.options.number);

    const puralized = (count, single, plural) => `${count} ${count != 1 ? plural : single}`;
    this.serverless.cli.log(`${functionName} has ${puralized(versions.length - 1, 'version', 'versions')} published and ${puralized(aliases.length, 'alias', 'aliases')}, ${puralized(deletionCandidates.length, 'version', 'versions')} selected for deletion`);
  
    return deletionCandidates;
  }

}

module.exports = PrunePlugin;