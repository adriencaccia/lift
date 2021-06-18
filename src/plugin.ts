import { get, has, merge } from "lodash";
import chalk from "chalk";
import { AwsIamPolicyStatements } from "@serverless/typescript";
import * as path from "path";
import { readFileSync } from "fs";
import { dump } from "js-yaml";
import { DefaultTokenResolver, Lazy, StringConcat, Tokenization } from "@aws-cdk/core";
import type { CommandsDefinition, Hook, Serverless, VariableResolver } from "./types/serverless";
import { AwsProvider, ConstructInterface } from "./classes";
import { log } from "./utils/logger";
import { StaticConstructInterface } from "./classes/Construct";
import { Storage } from "./constructs/Storage";
import { Queue } from "./constructs/Queue";
import { Webhook } from "./constructs/Webhook";
import { StaticWebsite } from "./constructs/StaticWebsite";

const CONSTRUCT_ID_PATTERN = "^[a-zA-Z0-9-_]+$";
const CONSTRUCTS_DEFINITION = {
    type: "object",
    patternProperties: {
        [CONSTRUCT_ID_PATTERN]: {
            allOf: [
                {
                    type: "object",
                    properties: {
                        type: { type: "string" },
                    },
                    required: ["type"],
                },
            ] as Record<string, unknown>[],
        },
    },
    additionalProperties: false,
};

/**
 * Serverless plugin
 */
class LiftPlugin {
    private constructs?: Record<string, ConstructInterface>;
    private readonly serverless: Serverless;
    private readonly providers: AwsProvider[] = [];
    private readonly schema = CONSTRUCTS_DEFINITION;
    public readonly hooks: Record<string, Hook>;
    public readonly commands: CommandsDefinition = {};
    public readonly configurationVariablesSources: Record<string, VariableResolver> = {};
    private readonly cliOptions: Record<string, string>;

    constructor(serverless: Serverless, cliOptions: Record<string, string>) {
        this.serverless = serverless;
        this.cliOptions = cliOptions;

        this.commands.lift = {
            commands: {
                eject: {
                    usage: "Eject Lift constructs to raw CloudFormation",
                    lifecycleEvents: ["eject"],
                },
            },
        };

        this.hooks = {
            initialize: () => {
                this.loadConstructs();
                this.appendPermissions();
                this.resolveLazyVariables();
            },
            "before:aws:info:displayStackOutputs": this.info.bind(this),
            "after:package:compileEvents": this.appendCloudformationResources.bind(this),
            "after:deploy:deploy": this.postDeploy.bind(this),
            "before:remove:remove": this.preRemove.bind(this),
            "lift:eject:eject": this.eject.bind(this),
        };

        this.configurationVariablesSources = {
            construct: {
                resolve: this.resolveReference.bind(this),
            },
        };

        this.registerProviders();
        /**
         * This is representative of a possible public API to register constructs. How it would work:
         * - 3rd party developers create a custom construct
         * - they also create a plugin that calls:
         *       const awsProvider = serverless.lift.getProvider("aws");
         *       awsProvider.registerConstructs(Foo, Bar);
         *  If they use TypeScript, `registerConstructs()` will validate that the construct class
         *  implements both static fields (type, schema, create(), …) and non-static fields (outputs(), references(), …).
         */
        this.providers[0].registerConstructs(Storage, Queue, Webhook, StaticWebsite);
        this.registerConstructsSchema();
        this.registerConfigSchema();
        this.registerCommands();
    }

    private registerConstructsSchema() {
        this.schema.patternProperties[CONSTRUCT_ID_PATTERN].allOf.push({
            oneOf: this.getAllConstructClasses().map((Construct) => {
                return this.defineConstructSchema(Construct.type, Construct.schema);
            }),
        });
    }

    private defineConstructSchema(
        constructName: string,
        configSchema: Record<string, unknown>
    ): Record<string, unknown> {
        return merge(configSchema, { properties: { type: { const: constructName } } });
    }

    private registerConfigSchema() {
        this.serverless.configSchemaHandler.defineTopLevelProperty("constructs", this.schema);
    }

    private registerProviders() {
        this.providers.push(new AwsProvider(this.serverless));
    }

    private loadConstructs(): void {
        if (this.constructs !== undefined) {
            // Safeguard
            throw new Error("Constructs are already initialized: this should not happen");
        }
        this.constructs = {};
        const constructsInputConfiguration = get(this.serverless.configurationInput, "constructs", {});
        for (const [id, { type }] of Object.entries(constructsInputConfiguration)) {
            const provider = this.providers[0];
            this.constructs[id] = provider.create(type, id);
        }
    }

    private getConstructs(): Record<string, ConstructInterface> {
        if (this.constructs === undefined) {
            // Safeguard
            throw new Error("Constructs are not initialized: this should not happen");
        }

        return this.constructs;
    }

    resolveReference({ address }: { address: string }): { value: string } {
        return {
            /**
             * Construct variables are resolved lazily using the CDK's "Token" system.
             * CDK Lazy values generate a unique `${Token[TOKEN.63]}` string. These strings
             * can later be resolved to the real value (which we do in `initialize()`).
             * Problem:
             * - Lift variables need constructs to be resolved
             * - Constructs can be created when Serverless variables are resolved
             * - Serverless variables must resolve Lift variables
             * This is a chicken and egg problem.
             * Solution:
             * - Serverless boots, plugins are created
             * - variables are resolved
             *   - Lift variables are resolved to CDK tokens (`${Token[TOKEN.63]}`) via `Lazy.any(...)`
             *     (we can't resolve the actual values since we don't have the constructs yet)
             * - `initialize` hook
             *   - Lift builds the constructs
             *   - CDK tokens are resolved into real value: we can now do that using the CDK "token resolver"
             */
            value: Lazy.any({
                produce: () => {
                    const constructs = this.getConstructs();
                    const [id, property] = address.split(".", 2);
                    if (!has(this.constructs, id)) {
                        throw new Error(
                            `No construct named '${id}' was found, the \${construct:${id}.${property}} variable is invalid.`
                        );
                    }
                    const construct = constructs[id];

                    const properties = construct.references();
                    if (!has(properties, property)) {
                        throw new Error(
                            `\${construct:${id}.${property}} does not exist. Properties available on \${construct:${id}} are: ${Object.keys(
                                properties
                            ).join(", ")}.`
                        );
                    }

                    return properties[property];
                },
            }).toString(),
        };
    }

    async info(): Promise<void> {
        const constructs = this.getConstructs();
        for (const [id, construct] of Object.entries(constructs)) {
            const outputs = construct.outputs();
            if (Object.keys(outputs).length > 0) {
                console.log(chalk.yellow(`${id}:`));
                for (const [name, resolver] of Object.entries(outputs)) {
                    const output = await resolver();
                    if (output !== undefined) {
                        console.log(`  ${name}: ${output}`);
                    }
                }
            }
        }
    }

    private registerCommands() {
        const constructsConfiguration = get(this.serverless.configurationInput, "constructs", {}) as Record<
            string,
            { type: string }
        >;
        // For each construct
        for (const [id, constructConfig] of Object.entries(constructsConfiguration)) {
            const constructClass = this.getConstructClass(constructConfig.type);
            if (constructClass.commands === undefined) {
                continue;
            }
            // For each command of the construct
            for (const [command, commandDefinition] of Object.entries(constructClass.commands())) {
                this.commands[`${id}:${command}`] = {
                    lifecycleEvents: [command],
                    usage: commandDefinition.usage,
                    options: commandDefinition.options,
                };
                // Register the command handler
                this.hooks[`${id}:${command}:${command}`] = () => {
                    // We resolve the construct instance on the fly
                    const construct = this.getConstructs()[id];

                    return commandDefinition.handler.call(construct, this.cliOptions);
                };
            }
        }
    }

    private async postDeploy(): Promise<void> {
        const constructs = this.getConstructs();
        for (const [, construct] of Object.entries(constructs)) {
            if (construct.postDeploy !== undefined) {
                await construct.postDeploy();
            }
        }
    }

    private async preRemove(): Promise<void> {
        const constructs = this.getConstructs();
        for (const [, construct] of Object.entries(constructs)) {
            if (construct.preRemove !== undefined) {
                await construct.preRemove();
            }
        }
    }

    private resolveLazyVariables() {
        // Use the CDK token resolver to resolve all lazy variables in the template
        const tokenResolver = new DefaultTokenResolver(new StringConcat());
        const resolveTokens = <T>(input: T): T => {
            if (input === undefined) {
                return input;
            }

            return Tokenization.resolve(input, {
                resolver: tokenResolver,
                scope: this.providers[0].stack,
            }) as T;
        };
        this.serverless.service.provider = resolveTokens(this.serverless.service.provider);
        this.serverless.service.functions = resolveTokens(this.serverless.service.functions);
        this.serverless.service.custom = resolveTokens(this.serverless.service.custom);
        this.serverless.service.resources = resolveTokens(this.serverless.service.resources);
        this.serverless.service.layers = resolveTokens(this.serverless.service.layers);
        this.serverless.service.outputs = resolveTokens(this.serverless.service.outputs);
    }

    private appendCloudformationResources() {
        this.providers[0].appendCloudformationResources();
    }

    private appendPermissions(): void {
        const constructs = this.getConstructs();
        const statements = Object.entries(constructs)
            .map(([, construct]) => {
                return ((construct.permissions ? construct.permissions() : []) as unknown) as AwsIamPolicyStatements;
            })
            .flat(1);
        if (statements.length === 0) {
            return;
        }
        this.serverless.service.provider.iamRoleStatements = this.serverless.service.provider.iamRoleStatements ?? [];
        this.serverless.service.provider.iamRoleStatements.push(...statements);
    }

    private async eject() {
        log("Ejecting from Lift to CloudFormation");
        await this.serverless.pluginManager.spawn("package");
        const legacyProvider = this.serverless.getProvider("aws");
        const compiledTemplateFileName = legacyProvider.naming.getCompiledTemplateFileName();
        const compiledTemplateFilePath = path.join(this.serverless.serviceDir, ".serverless", compiledTemplateFileName);
        const cfTemplate = readFileSync(compiledTemplateFilePath);
        const formattedYaml = dump(JSON.parse(cfTemplate.toString()));
        console.log(formattedYaml);
        log("You can also find that CloudFormation template in the following file:");
        log(compiledTemplateFilePath);
    }

    private getAllConstructClasses(): StaticConstructInterface<never>[] {
        return this.providers.map((provider) => provider.getAllConstructClasses()).flat(1);
    }

    private getConstructClass(constructType: string): StaticConstructInterface<never> {
        const match = this.getAllConstructClasses().find((constructClass) => constructClass.type === constructType);
        if (match === undefined) {
            // TODO ServerlessError
            throw new Error(`Unknown construct type ${constructType}`);
        }

        return match;
    }
}

module.exports = LiftPlugin;
