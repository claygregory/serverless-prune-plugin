
# Serverless Prune Plugin

Following deployment, the Serverless Framework does not purge previous versions of functions from AWS, so the number of deployed versions can grow out of hand rather quickly. This plugin allows pruning of all but the most recent version(s) of managed functions from AWS. This plugin targets Serverless 1.x.

[![Serverless](http://public.serverless.com/badges/v3.svg)](http://www.serverless.com)
[![Build Status](https://travis-ci.org/claygregory/serverless-prune-plugin.svg?branch=master)](https://travis-ci.org/claygregory/serverless-prune-plugin)
[![Coverage Status](https://coveralls.io/repos/github/claygregory/serverless-prune-plugin/badge.svg?branch=master)](https://coveralls.io/github/claygregory/serverless-prune-plugin?branch=master)

## Installation

Install with **npm**:
```sh
npm install --save-dev serverless-prune-plugin
```

And then add the plugin to your `serverless.yml` file:
```yaml
plugins:
  - serverless-prune-plugin
```

Alternatively, install with the Serverless **plugin command** (Serverless Framework 1.22 or higher):
```sh
sls plugin install -n serverless-prune-plugin
```

## Usage

In the project root, run:
```sh
sls prune -n <number of version to keep>
```

This will delete all but the `n`-most recent versions of each function deployed. Versions referenced by an alias are automatically preserved.

### Single Function

A single function can be targeted for cleanup:
```sh
sls prune -n <number of version to keep> -f helloWorld
```

### Region/Stage

The previous usage examples prune the default stage in the default region. Use `--stage` and `--region` to specify: 
```sh
sls prune -n <number of version to keep> --stage production --region eu-central-1
```

### Automatic Pruning

This plugin can also be configured to run automatically, following a deployment. Configuration of automatic pruning is within the `custom` property of `serverless.yml`. For example:

```yaml
custom:
  prune:
    automatic: true
    number: 3
```

To run automatically, the `automatic` property of `prune` must be set to `true` and the `number` of versions to keep must be specified.


### Dry Run

A dry-run will preview the deletion candidates, without actually performing the pruning operations:
```sh
sls prune -n <number of version to keep> --dryRun
```

### Additional Help

See:
```sh
sls prune --help
```

## See Also

The [Serverless Autoprune Plugin](https://github.com/arabold/serverless-autoprune-plugin) by [arabold](https://github.com/arabold) performs a similar role, but targets Serverless 0.5.x projects.

## License

See the included [LICENSE](LICENSE.md) for rights and limitations under the terms of the MIT license.
