import { BlockPublicAccess, Bucket, BucketEncryption, StorageClass } from "@aws-cdk/aws-s3";
import { Construct as CdkConstruct, CfnOutput, Duration, Fn, Stack } from "@aws-cdk/core";
import { FromSchema } from "json-schema-to-ts";
import Construct from "../classes/Construct";
import AwsProvider from "../classes/AwsProvider";
import { PolicyStatement } from "../CloudFormation";

export const STORAGE_DEFINITION = {
    type: "object",
    properties: {
        type: { const: "storage" },
        archive: { type: "number", minimum: 30 },
        encryption: {
            anyOf: [{ const: "s3" }, { const: "kms" }],
        },
    },
    additionalProperties: false,
} as const;
const STORAGE_DEFAULTS: Required<FromSchema<typeof STORAGE_DEFINITION>> = {
    type: "storage",
    archive: 45,
    encryption: "s3",
};

export class Storage extends CdkConstruct implements Construct {
    private readonly bucket: Bucket;
    private readonly bucketNameOutput: CfnOutput;

    constructor(
        scope: CdkConstruct,
        id: string,
        configuration: FromSchema<typeof STORAGE_DEFINITION>,
        private readonly provider: AwsProvider
    ) {
        super(scope, id);

        const resolvedConfiguration = Object.assign({}, STORAGE_DEFAULTS, configuration);

        const encryptionOptions = {
            s3: BucketEncryption.S3_MANAGED,
            kms: BucketEncryption.KMS_MANAGED,
        };

        this.bucket = new Bucket(this, "Bucket", {
            encryption: encryptionOptions[resolvedConfiguration.encryption],
            versioned: true,
            blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            lifecycleRules: [
                {
                    transitions: [
                        {
                            storageClass: StorageClass.INTELLIGENT_TIERING,
                            transitionAfter: Duration.days(0),
                        },
                    ],
                },
                {
                    noncurrentVersionExpiration: Duration.days(30),
                },
            ],
        });

        this.bucketNameOutput = new CfnOutput(this, "BucketName", {
            value: this.bucket.bucketName,
        });
    }

    references(): Record<string, Record<string, unknown>> {
        return {
            bucketArn: this.referenceBucketArn(),
            bucketName: this.referenceBucketName(),
        };
    }

    permissions(): PolicyStatement[] {
        return [
            new PolicyStatement(
                ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:ListBucket"],
                [
                    this.referenceBucketArn(),
                    // @ts-expect-error join only accepts a list of strings, whereas other intrinsic functions are commonly accepted
                    Stack.of(this).resolve(Fn.join("/", [this.referenceBucketArn(), "*"])),
                ]
            ),
        ];
    }

    commands(): Record<string, () => void | Promise<void>> {
        return {};
    }

    outputs(): Record<string, () => Promise<string | undefined>> {
        return {
            bucketName: () => this.getBucketName(),
        };
    }

    referenceBucketName(): Record<string, unknown> {
        return this.provider.getCloudFormationReference(this.bucket.bucketName);
    }

    referenceBucketArn(): Record<string, unknown> {
        return this.provider.getCloudFormationReference(this.bucket.bucketArn);
    }

    async getBucketName(): Promise<string | undefined> {
        return this.provider.getStackOutput(this.bucketNameOutput);
    }
}
