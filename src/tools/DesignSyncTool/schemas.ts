import { z } from 'zod/v4'
import { DESIGN_MAX_BATCH, DESIGN_MAX_PATH_BYTES } from '../../services/design/constants.js'
import { lazySchema } from '../../utils/lazySchema.js'

const projectPath = z.string().min(1).max(DESIGN_MAX_PATH_BYTES)

const fileInput = z.strictObject({
  path: projectPath.describe(
    'Path within the project, e.g. components/button/index.html',
  ),
  localPath: z.string().min(1).optional(),
  data: z.string().optional(),
  encoding: z.enum(['base64']).optional(),
  mimeType: z.string().optional(),
})

const assetInput = z.strictObject({
  name: z.string().min(1).max(255),
  path: projectPath,
  subtitle: z.string().max(255).optional(),
  viewport: z
    .strictObject({
      width: z.number().int().positive(),
      height: z.number().int().positive().optional(),
    })
    .optional(),
  group: z.string().max(64).optional(),
})

export const designSyncInputSchema = lazySchema(() =>
  z.strictObject({
    method: z.enum([
      'list_projects',
      'get_project',
      'list_files',
      'get_file',
      'finalize_plan',
      'write_files',
      'delete_files',
      'register_assets',
      'unregister_assets',
      'create_project',
      'report_validate',
    ]),
    projectId: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    writes: z.array(projectPath).max(DESIGN_MAX_BATCH).optional(),
    deletes: z.array(projectPath).max(DESIGN_MAX_BATCH).optional(),
    planId: z.string().min(1).optional(),
    files: z.array(fileInput).max(DESIGN_MAX_BATCH).optional(),
    paths: z.array(projectPath).max(DESIGN_MAX_BATCH).optional(),
    name: z.string().min(1).max(200).optional(),
    assets: z.array(assetInput).max(DESIGN_MAX_BATCH).optional(),
    localDir: z.string().min(1).optional(),
    counts: z
      .object({
        total: z.number().int().nonnegative(),
        bad: z.number().int().nonnegative(),
        thin: z.number().int().nonnegative(),
        variantsIdentical: z.number().int().nonnegative(),
        iterations: z.number().int().nonnegative(),
      })
      .optional(),
  }),
)

const notice = { notice: z.string().optional() }

export const designSyncOutputSchema = lazySchema(() =>
  z.discriminatedUnion('method', [
    z.object({
      method: z.literal('list_projects'),
      ...notice,
      projects: z.array(
        z.object({
          projectId: z.string(),
          name: z.string(),
          ownerDisplayName: z.string().optional(),
          isOwned: z.boolean().optional(),
          updatedAt: z.string().optional(),
        }),
      ),
    }),
    z.object({
      method: z.literal('get_project'),
      ...notice,
      projectId: z.string(),
      name: z.string(),
      type: z.string().optional(),
      ownerDisplayName: z.string().optional(),
      isOwned: z.boolean().optional(),
      canEdit: z.boolean().optional(),
    }),
    z.object({
      method: z.literal('list_files'),
      ...notice,
      paths: z.array(z.string()),
    }),
    z.object({
      method: z.literal('get_file'),
      ...notice,
      path: z.string(),
      content: z.string(),
      contentType: z.string(),
      isBase64: z.boolean(),
      truncated: z.boolean(),
    }),
    z.object({
      method: z.literal('finalize_plan'),
      ...notice,
      planId: z.string(),
      writes: z.array(z.string()),
      deletes: z.array(z.string()),
    }),
    z.object({ method: z.literal('write_files'), ...notice, written: z.number() }),
    z.object({ method: z.literal('delete_files'), ...notice, deleted: z.number() }),
    z.object({ method: z.literal('register_assets'), ...notice, registered: z.number() }),
    z.object({ method: z.literal('unregister_assets'), ...notice, unregistered: z.number() }),
    z.object({
      method: z.literal('create_project'),
      ...notice,
      projectId: z.string(),
      name: z.string(),
    }),
    z.object({ method: z.literal('report_validate'), ...notice }),
  ]),
)

export type DesignSyncInput = z.infer<ReturnType<typeof designSyncInputSchema>>
export type DesignSyncOutput = z.infer<ReturnType<typeof designSyncOutputSchema>>
export type DesignSyncFileInput = z.infer<typeof fileInput>

const requirements: Record<
  DesignSyncInput['method'],
  { present: Array<keyof DesignSyncInput>; nonEmpty: Array<keyof DesignSyncInput> }
> = {
  list_projects: { present: [], nonEmpty: [] },
  get_project: { present: ['projectId'], nonEmpty: [] },
  list_files: { present: ['projectId'], nonEmpty: [] },
  get_file: { present: ['projectId', 'path'], nonEmpty: [] },
  finalize_plan: {
    present: ['projectId', 'writes', 'deletes'],
    nonEmpty: [],
  },
  write_files: {
    present: ['projectId', 'planId'],
    nonEmpty: ['files'],
  },
  delete_files: {
    present: ['projectId', 'planId'],
    nonEmpty: ['paths'],
  },
  register_assets: {
    present: ['projectId', 'planId'],
    nonEmpty: ['assets'],
  },
  unregister_assets: {
    present: ['projectId', 'planId'],
    nonEmpty: ['paths'],
  },
  create_project: { present: ['name'], nonEmpty: [] },
  report_validate: { present: ['counts'], nonEmpty: [] },
}

export function missingDesignSyncFields(input: DesignSyncInput): string[] {
  const requirement = requirements[input.method]
  return [
    ...requirement.present.filter(key => input[key] === undefined),
    ...requirement.nonEmpty.filter(key => {
      const value = input[key]
      return value === undefined || (Array.isArray(value) && value.length === 0)
    }),
  ]
}
