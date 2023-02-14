import * as base from '../../../lib/template/stack/base/base-stack';
import { AppContext } from '../../../lib/template/app-context';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as cdk from 'aws-cdk-lib';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';


export class Sample3ServiceStack extends base.BaseStack {

    constructor(appContext: AppContext, stackConfig: any) {
        super(appContext, stackConfig);

        const resourceSuffix = appContext.stackCommonProps.projectPrefix + 'x'
        // const githubOwnerName = "modularcloud"

        // const githubRepository = "ChainDataPuller-Hub-DymensionLocaltestnet-DEV"


        const githubOwnerName = "mhstom"
        const githubRepository = "aws-cdk-deploy-pipeline-using-aws-codepipeline"
    
        const githubPersonalTokenSecretName = "modular-cloud-aws-code-pipeline-personal-access-token"
        
        const serviceName = "ChainDataPuller-Hub-DymensionLocaltestnet-DEV"
        
        
        //default: `${this.stackName}`
    
        const ecrRepo = new ecr.Repository(this, 'ecr-repo-' + resourceSuffix);
    
        /**
         * create a new vpc with single nat gateway
         */
        const vpc = new ec2.Vpc(this, 'ecs-vpc' + resourceSuffix, {
          cidr: '10.0.0.0/16',
          natGateways: 1,
          maxAzs: 3  /* does a sample need 3 az's? */
        });
    
        const clusteradmin = new iam.Role(this, 'adminrole-' + resourceSuffix, {
          assumedBy: new iam.AccountRootPrincipal()
        });
    
        const cluster = new ecs.Cluster(this, "ecs-cluster-" + resourceSuffix, {
          vpc: vpc,
        });
    
        const logging = new ecs.AwsLogDriver({
          streamPrefix: "ecs-logs"
        });
    
        const taskrole = new iam.Role(this, 'ecs-taskrole-' + resourceSuffix, {
          roleName: 'ecs-taskrole-' + resourceSuffix,
          assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com')
        });
    
    
    
        // ***ecs contructs***
    
        const executionRolePolicy =  new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          resources: ['*'],
          actions: [
                    "ecr:getauthorizationtoken",
                    "ecr:batchchecklayeravailability",
                    "ecr:getdownloadurlforlayer",
                    "ecr:batchgetimage",
                    "logs:createlogstream",
                    "logs:putlogevents"
                ]
        });
    
        const taskDef = new ecs.FargateTaskDefinition(this, "ecs-taskdef-" + resourceSuffix, {
          taskRole: taskrole
        });
    
        taskDef.addToExecutionRolePolicy(executionRolePolicy);
    
        const baseImage = 'public.ecr.aws/amazonlinux/amazonlinux:2022'
        const container = taskDef.addContainer("container-" + resourceSuffix, {
          image: ecs.ContainerImage.fromRegistry(baseImage),
          memoryLimitMiB: 256,
          cpu: 256,
          logging
        });
    
        container.addPortMappings({
          containerPort: 5000,
          protocol: ecs.Protocol.TCP
        });
    
        const fargateService = new ecs_patterns.ApplicationLoadBalancedFargateService(this, "ecs-service-" + resourceSuffix, {
          cluster: cluster,
          taskDefinition: taskDef,
          publicLoadBalancer: true,
          desiredCount: 1,
          listenerPort: 80
        });
    
    
        /* where do these constants come from? 6, 10, 60? */
    
        const scaling = fargateService.service.autoScaleTaskCount({ maxCapacity: 6 });
        scaling.scaleOnCpuUtilization('cpuscaling', {
          targetUtilizationPercent: 10,
          scaleInCooldown: cdk.Duration.seconds(60),
          scaleOutCooldown: cdk.Duration.seconds(60)
        });
    
        const gitHubSource = codebuild.Source.gitHub({
          owner: githubOwnerName,
          repo: githubRepository,
          webhook: true, // optional, default: true if `webhookfilteres` were provided, false otherwise
          webhookFilters: [
            codebuild.FilterGroup.inEventOf(codebuild.EventAction.PUSH).andBranchIs('main'),
          ], // optional, by default all pushes and pull requests will trigger a build
        });
    
        // codebuild - project
        const project = new codebuild.Project(this, 'project-' + resourceSuffix, {
          projectName: 'project-' + resourceSuffix,
          source: gitHubSource,
          environment: {
            buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_2,
            privileged: true
          },
          environmentVariables: {
            'cluster_name': {
              value: `${cluster.clusterName}`
            },
            'ecr_repo_uri': {
              value: `${ecrRepo.repositoryUri}`
            },
            'container_image_file': {
              value: '[{\"name\":\"Container-' + resourceSuffix + '\",\"imageUri\":\"%s\"}]'
            },
            'github_person_token': {
              value: githubPersonalTokenSecretName,
              type: codebuild.BuildEnvironmentVariableType.SECRETS_MANAGER,
            }
          },
          badge: true,
          // TODO - I had to hardcode tag here
          buildSpec: codebuild.BuildSpec.fromObject({
            version: "0.2",
            phases: {
              pre_build: {
                /*
                commands: [
                  'env',
                  'export tag=${CODEBUILD_RESOLVED_SOURCE_VERSION}'
                ]
                */
                commands: [
                  'env',
                  'export tag=latest'
                ]
              },
              build: {
                commands: [
                  `docker build --build-arg GITHUB_PERSONAL_TOKEN=$github_person_token -t $ecr_repo_uri:$tag .`,
                  '$(aws ecr get-login --no-include-email)',
                  'docker push $ecr_repo_uri:$tag'
                ]
              },
              post_build: {
                commands: [
                  'echo "in post-build stage"',
                  "printf $container_image_file $ecr_repo_uri:$tag > imagedefinitions.json",
                  "pwd; ls -al; cat imagedefinitions.json"
                ]
              }
            },
            artifacts: {
              files: [
                'imagedefinitions.json'
              ]
            }
          })
        });
    
    
        ecrRepo.grantPullPush(project.role!)
        project.addToRolePolicy(new iam.PolicyStatement({
          actions: [
            "ecs:describecluster",
            "ecr:getauthorizationtoken",
            "ecr:batchchecklayeravailability",
            "ecr:batchgetimage",
            "ecr:getdownloadurlforlayer"
            ],
          resources: [`${cluster.clusterArn}`],
        }));

        project.addToRolePolicy(new iam.PolicyStatement({
            actions: [
                "s3:Abort*",
                "s3:DeleteObject*",
                "s3:GetBucket*",
                "s3:GetObject*",
                "s3:List*",
                "s3:PutObject",
                "s3:PutObjectLegalHold",
                "s3:PutObjectRetention",
                "s3:PutObjectTagging",
                "s3:PutObjectVersionTagging"
              ],
            resources: ["*"],
          }));
    
        new cdk.CfnOutput(this, "image" + resourceSuffix, { value: ecrRepo.repositoryUri+":latest"} )
        new cdk.CfnOutput(this, 'loadbalancerdns' + resourceSuffix , { value: fargateService.loadBalancer.loadBalancerDnsName });
        new cdk.CfnOutput(this, 'projectArn' + resourceSuffix, { value: project.projectArn, exportName: 'projectArn-' + resourceSuffix});
        new cdk.CfnOutput(this, 'projectName' + resourceSuffix, { value: project.projectName, exportName: 'projectName-' + resourceSuffix});
        new cdk.CfnOutput(this, 'fargateServiceClusterArn' + resourceSuffix, { value: fargateService.service.cluster.clusterArn,  exportName: 'fargateServiceClusterArn-' + resourceSuffix});
        new cdk.CfnOutput(this, 'fargateServiceArn' + resourceSuffix, { value: fargateService.service.serviceArn, exportName: 'fargateServiceArn-' + resourceSuffix});
        new cdk.CfnOutput(this, 'fargateServiceName' + resourceSuffix, { value: fargateService.service.serviceName, exportName: 'fargateServiceName-' + resourceSuffix});
    }
}
