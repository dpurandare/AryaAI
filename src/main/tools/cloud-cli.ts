import { makeCliTool } from './cli-tool'

export const awsCliTool = makeCliTool('aws', 'aws_cli', 'AWS')
export const azureCliTool = makeCliTool('az', 'azure_cli', 'Azure')
export const gcloudCliTool = makeCliTool('gcloud', 'gcloud_cli', 'Google Cloud')
