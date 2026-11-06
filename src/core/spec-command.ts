import { z } from 'zod';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import type { CommandDefinition } from './types.js';
import { ValidationError } from './errors.js';

type Schema = Record<string, any>;
interface SpecParameter {
  name: string;
  field: string;
  location: string;
  required: boolean;
  schema: Schema;
  description: string;
}
interface SpecCommand {
  name: string;
  group: string;
  subcommand: string;
  description: string;
  endpoint: CommandDefinition['endpoint'];
  parameters: SpecParameter[];
  body?: Schema;
  bodyRequired?: boolean;
  responseText?: boolean;
}

const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: true });
addFormats(ajv);

// Zod describes the tool inputs. AJV enforces the complete original schema,
// including conditional and negative schemas that Zod cannot represent.
function toolSchema(schema: Schema): Schema {
  const result: Schema = { ...schema };
  for (const key of ['not', 'if', 'then', 'else', 'default', 'example', 'examples', 'x-enumDescriptions']) delete result[key];
  for (const key of ['properties', 'patternProperties', '$defs', 'definitions']) {
    if (result[key]) result[key] = Object.fromEntries(Object.entries(result[key]).map(([name, child]) => [name, toolSchema(child as Schema)]));
  }
  for (const key of ['items', 'additionalProperties']) {
    if (result[key] && typeof result[key] === 'object') result[key] = toolSchema(result[key]);
  }
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    if (result[key]) result[key] = result[key].map(toolSchema);
  }
  // Removing unsupported negative/conditional keywords can broaden branches.
  // Use an inclusive view so that only AJV decides exclusive-union validity.
  if (result.oneOf) { result.anyOf = result.oneOf; delete result.oneOf; }
  return result;
}

function inputSchema(schema: Schema, json: boolean, required: boolean): z.ZodType {
  const view = z.fromJSONSchema(toolSchema(schema));
  let validate: ReturnType<typeof ajv.compile> | undefined;
  const checked = view.superRefine((value, ctx) => {
    validate ??= ajv.compile(schema);
    if (!validate(value)) ctx.addIssue({ code: 'custom', message: ajv.errorsText(validate.errors) });
  });
  if (!json && schema.type === 'string') return required ? checked : checked.optional();
  // Describe both accepted forms to MCP: native JSON values or a CLI JSON string.
  const parsed = z.union([view, z.string()]).transform((value, ctx) => {
    let native = value;
    if (typeof value === 'string' && (json || !view.safeParse(value).success)) {
      try { native = JSON.parse(value); }
      catch { ctx.addIssue({ code: 'custom', message: 'Expected valid JSON' }); return z.NEVER; }
    }
    const result = checked.safeParse(native);
    if (!result.success) {
      for (const issue of result.error.issues) ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
      return z.NEVER;
    }
    return result.data;
  });
  return required ? parsed : parsed.optional();
}

export function createSpecCommand(spec: SpecCommand): CommandDefinition {
  const shape: Record<string, z.ZodType> = {};
  const options: NonNullable<CommandDefinition['cliMappings']['options']> = [];
  const mappings: CommandDefinition['fieldMappings'] = {};
  for (const parameter of spec.parameters) {
    const { field, schema, required } = parameter;
    shape[field] = inputSchema(schema, schema.type === 'object' || schema.type === 'array', required)
      .describe(parameter.description);
    const flag = field.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase();
    options.push({ field, flags: `--${flag} <value>`, description: `${parameter.description}${required ? ' (required)' : ''}` });
    mappings[field] = parameter.location as 'path' | 'query';
  }
  if (spec.body) {
    shape.body = inputSchema(spec.body, true, spec.bodyRequired === true).describe('JSON request body as documented in the public API');
    options.push({ field: 'body', flags: '--body <json>', description: `JSON request body${spec.bodyRequired ? ' (required)' : ''}` });
  }
  const command: CommandDefinition = {
    name: spec.name, group: spec.group, subcommand: spec.subcommand, description: spec.description,
    generated: true,
    endpoint: spec.endpoint,
    // Conservative: even POST previews use workspace write confirmation.
    mutating: spec.endpoint.method !== 'GET',
    inputSchema: z.object(shape), cliMappings: { options }, fieldMappings: mappings,
    handler: async (input, client) => {
      const result = command.inputSchema.safeParse(input);
      if (!result.success) throw new ValidationError(result.error.message);
      let path = spec.endpoint.path;
      const query: Record<string, any> = {};
      for (const p of spec.parameters) {
        const value = result.data[p.field];
        if (value === undefined) continue;
        if (p.location === 'path') path = path.replace(`{${p.name}}`, encodeURIComponent(String(value)));
        else query[p.name] = value;
      }
      return client.request({ method: spec.endpoint.method, path,
        query: Object.keys(query).length ? query : undefined, body: result.data.body,
        ...(spec.responseText ? { responseType: 'text' as const } : {}),
      });
    },
  };
  return command;
}
