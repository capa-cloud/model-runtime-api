import AjvModule from "ajv";
import type { ErrorObject, Options } from "ajv";

export const executionRequestSchema = {
  $id: "https://capa-cloud.github.io/model-runtime-api/schema/execution-request-0.1.json",
  type: "object",
  additionalProperties: false,
  required: ["ability", "input"],
  properties: {
    ability: { type: "string", minLength: 1, maxLength: 256 },
    input: {
      type: "array",
      minItems: 1,
      maxItems: 1024,
      items: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "text"],
            properties: { type: { const: "text" }, text: { type: "string" } },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "value"],
            properties: { type: { const: "json" }, value: {} },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "uri"],
            properties: {
              type: { enum: ["image", "audio", "video", "file"] },
              uri: { type: "string", minLength: 1, maxLength: 8192 },
              media_type: { type: "string", maxLength: 256 },
            },
          },
        ],
      },
    },
    requirements: {
      type: "object",
      additionalProperties: false,
      properties: {
        input_modalities: {
          type: "array",
          items: { enum: ["text", "image", "audio", "video", "file", "json"] },
          uniqueItems: true,
        },
        output_modalities: {
          type: "array",
          items: { enum: ["text", "image", "audio", "video", "file", "json"] },
          uniqueItems: true,
        },
        stream: { type: "boolean" },
        tools: { type: "boolean" },
        structured_output: { type: "boolean" },
        async: { type: "boolean" },
        cancel: { type: "boolean" },
      },
    },
    routing: {
      type: "object",
      additionalProperties: false,
      properties: {
        strategy: { enum: ["first_available", "ordered"] },
        provider_order: {
          type: "array",
          items: { type: "string", minLength: 1 },
          uniqueItems: true,
        },
        allow_fallback: { type: "boolean" },
        max_attempts: { type: "integer", minimum: 1, maximum: 32 },
        retry_budget_ms: { type: "integer", minimum: 1, maximum: 86_400_000 },
      },
    },
    deadline_ms: { type: "integer", minimum: 1, maximum: 86_400_000 },
    metadata: {
      type: "object",
      maxProperties: 64,
      additionalProperties: {
        anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
      },
    },
    extensions: { type: "object", maxProperties: 64, additionalProperties: true },
  },
} as const;

interface AjvLike {
  compile(schema: unknown): ((value: unknown) => boolean) & { errors?: ErrorObject[] | null };
}

const AjvConstructor = AjvModule as unknown as new (options?: Options) => AjvLike;
const ajv = new AjvConstructor({ allErrors: true, strict: true });
const validate = ajv.compile(executionRequestSchema);

export function validateExecutionRequest(value: unknown): {
  valid: boolean;
  errors: ErrorObject[];
} {
  const valid = validate(value);
  return { valid, errors: valid ? [] : [...(validate.errors ?? [])] };
}
