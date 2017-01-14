
# Serverless Prune Plugin

As the Serverless framework does not perform any sort of post-deployment cleanup, old versions of deployed functions are retained on AWS indefinitely. This plugin allows pruning of all but the most recent version(s) of managed functions. This plugin targets Serverless 1.x.

## Installation

Install to project via npm:
```
npm install --save-dev serverless-prune-plugin
```

Add the plugin to your `serverless.yml` file:
```yaml
plugins:
  - serverless-prune-plugin
```

## Usage

In the project root, run:
```
sls prune -n <number of version to keep>
```

This will delete all but the `n`-most recent versions of each function deployed. Versions referenced by an alias are automatically preserved.

### Single Function

A single function can be targeted for cleanup:
```
sls prune -n <number of version to keep> -f <function name>
```

### Additional Help

See:
```
sls prune --help
```

## See Also

The [Serverless Autoprune Plugin](https://github.com/arabold/serverless-autoprune-plugin) performs a similar function, but only targets Serverless 0.5.x projects.

##License

See the included [LICENSE](LICENSE.md) for rights and limitations under the terms of the MIT license.
