import {
  FCCustomDomainSpec,
  FCFunctionSpec,
  FCFunctionsStructure,
  FCFunctionStructure,
  FCSpec,
  HTTPEventType,
  FCProviderStructure,
} from './interface';
import { SpecBuilder } from '../builder';
import {
  HTTPEvent,
  TimerEvent,
  LogEvent,
  OSEvent,
  MQEvent,
} from '../interface';
import {
  uppercaseObjectKey,
  removeObjectEmptyAttributes,
  filterUserDefinedEnv,
  lowercaseObjectKey,
} from '../utils';

export class FCSpecBuilder extends SpecBuilder {
  toJSON() {
    const providerData: FCProviderStructure = this.getProvider();
    const serviceData = this.getService();
    const functionsData: FCFunctionsStructure = this.getFunctions();
    const serviceName = serviceData.name;
    const userDefinedEnv = filterUserDefinedEnv();

    const template: FCSpec = {
      ROSTemplateFormatVersion: '2015-09-01',
      Transform: 'Aliyun::Serverless-2018-04-03',
      Resources: {
        [`${serviceName}`]: {
          Type: 'Aliyun::Serverless::Service',
          Properties: {
            Description: serviceData.description,
            Role: providerData.role,
            InternetAccess: providerData.internetAccess,
            VpcConfig: uppercaseObjectKey(providerData.vpcConfig),
            Policies: uppercaseObjectKey(providerData.policies),
            LogConfig: uppercaseObjectKey(providerData.logConfig),
            NasConfig: uppercaseObjectKey(providerData.nasConfig),
            AsyncConfiguration: uppercaseObjectKey(
              providerData.asyncConfiguration
            ),
            TracingConfig: providerData.tracingConfig,
          },
        },
      },
    };

    let httpEventRouters;

    for (const funName in functionsData) {
      const funSpec: FCFunctionStructure = functionsData[funName];
      const handler = funSpec.handler || 'index.handler';
      const functionTemplate: FCFunctionSpec = {
        Type: 'Aliyun::Serverless::Function',
        Properties: {
          Description: funSpec.description || '',
          Initializer:
            funSpec.initializer ||
            handler.split('.').slice(0, -1).join('.') + '.initializer',
          Handler: handler,
          Runtime: funSpec.runtime || providerData.runtime || 'nodejs14',
          CodeUri: funSpec.codeUri || '.',
          Timeout: funSpec.timeout || providerData.timeout || 3,
          InitializationTimeout:
            funSpec.initTimeout || providerData.initTimeout || 3,
          MemorySize: funSpec.memorySize || providerData.memorySize || 128,
          EnvironmentVariables: {
            ...providerData.environment,
            ...funSpec.environment,
            ...userDefinedEnv,
          },
          InstanceConcurrency: funSpec.concurrency || 1,
        },
        Events: {},
      };

      for (const event of funSpec?.['events'] ?? []) {
        if (event['http']) {
          const evt = event['http'] as HTTPEvent;
          functionTemplate.Events[evt.name || 'http-' + funName] = {
            Type: 'HTTP',
            Properties: {
              AuthType:
                funSpec.authType || providerData.authType || 'ANONYMOUS', // 先写死
              Methods: convertMethods(evt.method),
              InvocationRole: evt.role,
              Qualifier: evt.version,
            },
          };

          if (!httpEventRouters) {
            httpEventRouters = {};
          }
          httpEventRouters[evt.path || '/*'] = {
            serviceName,
            functionName: funSpec.name || funName,
          };
        }

        if (event['timer']) {
          const evt = event['timer'] as TimerEvent;

          functionTemplate.Events[evt.name || 'timer'] = {
            Type: 'Timer',
            Properties: {
              CronExpression:
                evt.type === 'every' ? `@every ${evt.value}` : evt.value,
              Enable: evt.enable === false ? false : true,
              Payload: evt.payload,
              Qualifier: evt.version,
            },
          };
        }

        if (event['log']) {
          const evt = event['log'] as LogEvent;
          functionTemplate.Events[evt.name || 'log'] = {
            Type: 'Log',
            Properties: {
              SourceConfig: {
                Logstore: evt.source,
              },
              JobConfig: {
                MaxRetryTime: evt.retryTime || 1,
                TriggerInterval: evt.interval || 30,
              },
              LogConfig: {
                Project: evt.project,
                Logstore: evt.log,
              },
              Enable: true,
              InvocationRole: evt.role,
              Qualifier: evt.version,
            },
          };
        }

        const osEvent = event['os'] || event['oss'] || event['cos'];

        if (osEvent) {
          const evt = osEvent as OSEvent;
          functionTemplate.Events[evt.name || 'oss'] = {
            Type: 'OSS',
            Properties: {
              BucketName: evt.bucket,
              Events: [].concat(evt.events),
              Filter: {
                Key: {
                  Prefix: evt.filter.prefix,
                  Suffix: evt.filter.suffix,
                },
              },
              Enable: true,
              InvocationRole: evt.role,
              Qualifier: evt.version,
            },
          };
        }

        if (event['mq']) {
          const evt = event['mq'] as MQEvent;
          functionTemplate.Events[evt.name || 'mq'] = {
            Type: 'MNSTopic',
            Properties: {
              TopicName: evt.topic,
              NotifyContentFormat: 'JSON',
              NotifyStrategy: evt.strategy || 'BACKOFF_RETRY',
              Region: evt.region,
              FilterTag: evt.tags,
              InvocationRole: evt.role,
              Qualifier: evt.version,
            },
          };
        }
      }

      template.Resources[serviceName][funSpec.name || funName] =
        functionTemplate;
    }

    if (httpEventRouters) {
      const customDomain = this.originData?.['custom']?.['customDomain'];
      if (customDomain) {
        const { domainName } = customDomain;
        if (domainName === 'auto') {
          template.Resources['midway_auto_domain'] = {
            Type: 'Aliyun::Serverless::CustomDomain',
            Properties: {
              DomainName: 'Auto',
              Protocol: 'HTTP',
              RouteConfig: {
                routes: httpEventRouters,
              },
            },
          } as FCCustomDomainSpec;
        } else {
          template.Resources[domainName] = {
            Type: 'Aliyun::Serverless::CustomDomain',
            Properties: {
              Protocol: 'HTTP',
              RouteConfig: {
                routes: httpEventRouters,
              },
            },
          } as FCCustomDomainSpec;
        }
      } else if (customDomain !== false) {
        console.log('\n\n\n**************************************\n\n\n');
        console.log('Midway 于 2021/05/01 起不再提供默认自动域名配置。');
        console.log('\n');
        console.log('若需要使用自动域名，请在 f.yml 文件中加入如下配置：');
        console.log('\n');
        console.log('custom:');
        console.log('  customDomain:');
        console.log('    domainName: auto');
        console.log('\n\n\n**************************************\n\n\n');
        template.Resources['midway_auto_domain'] = {
          Type: 'Aliyun::Serverless::CustomDomain',
          Properties: {
            DomainName: 'Auto',
            Protocol: 'HTTP',
            RouteConfig: {
              routes: httpEventRouters,
            },
          },
        } as FCCustomDomainSpec;
      }
    }

    return removeObjectEmptyAttributes(template);
  }
}

export function convertMethods(methods: string | string[]): HTTPEventType[] {
  // ref: https://help.aliyun.com/document_detail/71229.html
  const all: HTTPEventType[] = [
    'GET',
    'PUT',
    'POST',
    'DELETE',
    'HEAD',
    'PATCH',
  ];
  if (typeof methods === 'string') {
    if (methods === 'any' || methods === 'all') {
      return all;
    }

    methods = [methods];
  } else if (methods?.length) {
    // has value
  } else {
    // empty
    return all;
  }

  return methods
    .map(method => {
      return method.toUpperCase();
    })
    .filter(method => all.includes(method as HTTPEventType)) as HTTPEventType[];
}

export class FCComponentSpecBuilder extends SpecBuilder {
  toJSON() {
    const providerData: FCProviderStructure = this.getProvider();
    const serviceData = this.getService();
    const functionsData: FCFunctionsStructure = this.getFunctions();
    const serviceName = serviceData.name;
    const userDefinedEnv = filterUserDefinedEnv();
    const specList = [];
    const service = {
      name: serviceName,
      description: serviceData.description,
      internetAccess: providerData.internetAccess,
      role: providerData.role,
      logConfig: lowercaseObjectKey(providerData.logConfig),
      vpcConfig: lowercaseObjectKey(providerData.vpcConfig),
      nasConfig: lowercaseObjectKey(providerData.nasConfig),
      tracingConfig: providerData.tracingConfig,
    };
    const region = providerData.region;
    const access = (providerData as any).access || 'default';
    let httpEventRouters;

    for (const funName in functionsData) {
      const funSpec: FCFunctionStructure = functionsData[funName];
      const handler = funSpec.handler || 'index.handler';
      const newSpec = {
        project: {
          provider: 'alibaba',
          access,
          projectName: serviceName,
        },
        props: {
          service,
          region,
          function: {
            name: funName,
            description: funSpec.description || '',
            // caPort: '', CustomContainer/Runtime指定端口
            // customContainerConfig: { image: '', command: '', args: ''}, 自定义镜像配置
            handler: handler,
            initializer:
              funSpec.initializer ||
              handler.split('.').slice(0, -1).join('.') + '.initializer',
            initializationTimeout:
              funSpec.initTimeout || providerData.initTimeout || 3,
            memorySize: funSpec.memorySize || providerData.memorySize || 128,
            runtime: funSpec.runtime || providerData.runtime || 'nodejs14',
            timeout: funSpec.timeout || providerData.timeout || 3,
            codeUri: funSpec.codeUri || '.',
            instanceConcurrency: funSpec.concurrency || 1,
            environmentVariables: {
              ...providerData.environment,
              ...funSpec.environment,
              ...userDefinedEnv,
            },
            asyncConfiguration: providerData.asyncConfiguration || '',
          },
          triggers: [],
          customDomains: [],
        },
      };
      specList.push(newSpec);

      for (const event of funSpec?.['events'] ?? []) {
        if (event['http']) {
          const evt = event['http'] as HTTPEvent;
          const methods = convertMethods(evt.method);
          newSpec.props.triggers.push({
            name: evt.name || 'http-' + funName,
            type: 'http',
            config: {
              authType: 'anonymous', // 先写死
              methods: methods,
              invocationRole: evt.role,
              qualifier: evt.version,
            },
          });

          // https://github.com/git-qfzhang/fc-deploy-alibaba-component/blob/master/examples/http-trigger/s.yaml
          if (!httpEventRouters) {
            httpEventRouters = [];
          }
          httpEventRouters.push({
            path: evt.path || '/*',
            serviceName,
            functionName: funSpec.name || funName,
            methods,
          });
        }

        if (event['timer']) {
          const evt = event['timer'] as TimerEvent;
          newSpec.props.triggers.push({
            name: evt.name || 'timer-' + funName,
            type: 'timer',
            config: {
              cronExpression:
                evt.type === 'every' ? `@every ${evt.value}` : evt.value,
              enable: evt.enable === false ? false : true,
              payload: evt.payload,
              qualifier: evt.version,
            },
          });
        }

        if (event['log']) {
          const evt = event['log'] as LogEvent;
          newSpec.props.triggers.push({
            name: evt.name || 'log-' + funName,
            type: 'log',
            config: {
              sourceConfig: {
                logstore: evt.source,
              },
              jobConfig: {
                maxRetryTime: evt.retryTime || 1,
                triggerInterval: evt.interval || 30,
              },
              logConfig: {
                project: evt.project,
                logstore: evt.log,
              },
              enable: true,
              invocationRole: evt.role,
              qualifier: evt.version,
            },
          });
        }

        const osEvent = event['os'] || event['oss'] || event['cos'];

        if (osEvent) {
          const evt = osEvent as OSEvent;
          newSpec.props.triggers.push({
            name: evt.name || 'oss-' + funName,
            type: 'oss',
            config: {
              bucketName: evt.bucket,
              events: [].concat(evt.events),
              filter: {
                key: {
                  Prefix: evt.filter.prefix,
                  Suffix: evt.filter.suffix,
                },
              },
              enable: true,
              invocationRole: evt.role,
              qualifier: evt.version,
            },
          });
        }
      }

      if (httpEventRouters?.length) {
        const customDomain = this.originData?.['custom']?.['customDomain'];
        if (customDomain) {
          const { domainName } = customDomain;
          if (domainName === 'auto') {
            newSpec.props.customDomains.push({
              domainName: 'auto',
              protocol: 'HTTP',
              routeConfigs: httpEventRouters,
            });
          } else {
            newSpec.props.customDomains.push({
              domainName,
              protocol: 'HTTP',
              routeConfigs: httpEventRouters,
            });
          }
        } else if (customDomain !== false) {
          console.log('\n\n\n**************************************\n\n\n');
          console.log('Midway 已于 2021/05/01 起不再默认提供自动域名配置。');
          console.log('\n');
          console.log('若需要使用自动域名，请在 f.yml 文件中加入如下配置：');
          console.log('\n');
          console.log('custom:');
          console.log('  customDomain:');
          console.log('    domainName: auto');
          console.log('\n\n\n**************************************\n\n\n');
          newSpec.props.customDomains.push({
            domainName: 'auto',
            protocol: 'HTTP',
            routeConfigs: httpEventRouters,
          });
        }
      }
    }
    return specList;
  }
}
