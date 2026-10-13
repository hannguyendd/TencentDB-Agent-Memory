/**
 * Generates the OpenAPI 3.0 for link A of the new panel (stateless).
 * Run: pnpm generate:meta-openapi
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  META_ACTIONS,
  META_LIST_ACTIONS,
  isNotInScopeAction,
} from '../src/panel/api/meta-actions.js';

const OUT = join(process.cwd(), 'docs/api/meta-api.openapi.yaml');

const ACTION_TAG: Record<string, string> = {
  user: 'Meta · User',
  'user-key': 'Meta · User Key',
  team: 'Meta · Team',
  'team-member': 'Meta · Team Member',
  agent: 'Meta · Agent',
  task: 'Meta · Task',
  'task-agent': 'Meta · Task Agent',
  asset: 'Meta · Asset',
  'agent-fixed-asset': 'Meta · Agent Fixed Asset',
  acl: 'Meta · ACL',
  auth: 'Meta · Auth',
};

const AUTH_VERIFY = 'auth/verify';

function tagFor(action: string): string {
  const prefix = action.includes('/') ? action.slice(0, action.indexOf('/')) : action;
  if (action.startsWith('team-member')) return ACTION_TAG['team-member'] ?? 'Meta';
  if (action.startsWith('user-key')) return ACTION_TAG['user-key'] ?? 'Meta';
  if (action.startsWith('task-agent')) return ACTION_TAG['task-agent'] ?? 'Meta';
  if (action.startsWith('agent-fixed-asset')) return ACTION_TAG['agent-fixed-asset'] ?? 'Meta';
  return ACTION_TAG[prefix] ?? 'Meta';
}

function yamlQuote(s: string): string {
  if (/^[a-zA-Z0-9_./-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

function panelDescription(action: string): string {
  if (isNotInScopeAction(action)) {
    return 'Phase 1 of the new panel does **not forward** to the kernel; Control returns HTTP 501, `message=NOT_IN_SCOPE`.';
  }
  if (action === AUTH_VERIFY) {
    return 'Login liveness check: Header only needs `X-Tdai-Service-Id`; body must contain `user_key`. On success check `data.valid` (soft validation).';
  }
  if (action === 'user/list') {
    return 'Transparent proxy; team_id may be omitted only by system_admin (instance-level list). Optional user_ids and username (exact match) filters. Response UserPublic includes username.';
  }
  if (action === 'team-member/list') {
    return 'Paginated list; body must include team_id. Response items are TeamMemberEntity (including username joined at read time, v3.2.2+); only active team members may call. Default joined_at DESC. Both Header credentials required.';
  }
  if (action === 'team-member/get') {
    return 'Transparent proxy; response TeamMemberEntity includes username (v3.2.2+, joined at read time). Caller must be an active team member. Both Header credentials required.';
  }
  if (action === 'team-member/add') {
    return 'Transparent proxy; team admin. Adding oneself and demoting the owner are forbidden. Response TeamMemberEntity **does not include** username (v3.2.2+); call team-member/list after adding to get the display name. v3.2.3+: adding the same role again for an active member → 409 member_already_exists.';
  }
  if (action === 'team-member/remove') {
    return 'Transparent proxy; team admin. Removing the team owner is forbidden (403 cannot remove team owner). Physically deletes the member row. Both Header credentials required.';
  }
  if (action === 'team/update') {
    return 'Transparent proxy; team owner or admin. owner_user_id cannot be changed (silently ignored if passed). See 08-metadata-v3-api-reference.md for fields. Both Header credentials required.';
  }
  if (action === 'agent/update') {
    return 'Transparent proxy; agent owner. owner_user_id cannot be changed (silently ignored if passed). See 08-metadata-v3-api-reference.md for fields. Both Header credentials required.';
  }
  if (action === 'user/create' || action === 'user/delete') {
    return 'Transparent proxy; Header `X-Tdai-User-Key` must belong to a system_admin. Non-admin → kernel 403.';
  }
  if (META_LIST_ACTIONS.has(action)) {
    return 'Paginated list; body accepts optional limit (default 20, max 100) and offset (default 0). Default created_at DESC (v3.1.2+; team-member uses joined_at DESC). Both Header credentials required.';
  }
  return 'Transparent proxy to the kernel; see 08-metadata-v3-api-reference.md for fields. Both Header credentials required.';
}

function buildMetaPostPath(action: string): string {
  const lines: string[] = [];
  lines.push(`  /api/v1/meta/${action}:`);
  lines.push('    post:');
  lines.push(`      tags: [${yamlQuote(tagFor(action))}]`);
  lines.push(`      operationId: meta_${action.replace(/\//g, '_')}`);
  lines.push(`      summary: ${action}`);
  lines.push(`      description: ${yamlQuote(panelDescription(action))}`);
  lines.push('      security: []');
  lines.push('      parameters:');
  lines.push("        - $ref: '#/components/parameters/TdaiServiceId'");
  if (action !== AUTH_VERIFY) {
    lines.push("        - $ref: '#/components/parameters/TdaiUserKey'");
  }
  lines.push('      requestBody:');
  lines.push('        required: true');
  lines.push('        content:');
  lines.push('          application/json:');
  lines.push('            schema:');
  lines.push('              type: object');
  lines.push('              additionalProperties: true');
  lines.push('      responses:');
  lines.push("        '200':");
  lines.push('          description: Kernel-style envelope (check body.code first for business success/failure)');
  lines.push('          content:');
  lines.push('            application/json:');
  lines.push('              schema:');
  lines.push("                $ref: '#/components/schemas/ApiResponse'");
  if (isNotInScopeAction(action)) {
    lines.push("        '501':");
    lines.push('          $ref: "#/components/responses/NotInScope"');
  }
  lines.push("        '400':");
  lines.push('          $ref: "#/components/responses/ControlBadRequest"');
  lines.push("        '502':");
  lines.push('          $ref: "#/components/responses/KernelUnavailable"');
  lines.push("        '504':");
  lines.push('          $ref: "#/components/responses/KernelTimeout"');
  return lines.join('\n');
}

const header = `openapi: 3.0.3
info:
  title: Team Memory Control — New Panel Metadata API (stateless)
  description: |
    The new panel Control is a **stateless proxy**: \`/api/v1/meta/*\` transparently forwards to the memory kernel \`/v3/meta/*\` (v3.1).

    **Authentication (Header, no cookie)**
    - \`X-Tdai-Service-Id\`: instance ID (from \`GET /meta/instances\`, = kernel \`x-tdai-service-id\`)
    - \`X-Tdai-User-Key\`: user key \`sk-mem-…\` (except \`auth/verify\`, where user_key goes only in the body)

    **Response envelope** \`{ code, message, request_id, data }\`
    - \`code === 0\` → HTTP **200** (request executed successfully)
    - \`code ∈ [400, 599]\` → HTTP equals code
    - Soft validation: \`auth/verify\` checks \`data.valid\`; \`acl/check\` checks \`data.allowed\`

    Design doc: [09-new-panel-control-backend-design.md](../architecture/09-new-panel-control-backend-design.md)
    Authoritative kernel fields: [08-metadata-v3-api-reference.md](../architecture/08-metadata-v3-api-reference.md)
  version: 1.3.1
  contact:
    name: team-memory-control

servers:
  - url: http://127.0.0.1:8123
    description: Local Control (\`PANEL_MODE=stateless\` or \`pnpm dev:panel\`)
  - url: https://{controlHost}
    description: Deployment environment
    variables:
      controlHost:
        default: control.example.com

tags:
  - name: Meta · Control
    description: Control auxiliary endpoints
  - name: Meta · User
  - name: Meta · User Key
  - name: Meta · Team
  - name: Meta · Team Member
  - name: Meta · Agent
  - name: Meta · Task
  - name: Meta · Task Agent
  - name: Meta · Asset
  - name: Meta · Agent Fixed Asset
  - name: Meta · ACL
  - name: Meta · Auth

paths:
  /api/v1/meta/instances:
    get:
      tags: [Meta · Control]
      operationId: meta_instances_list
      summary: Memory instance list (before login)
      description: |
        Returns all memory instances in the config file, **without pagination**.
        Exposes only \`instance_id\` and \`name\` (excluding gateway_endpoint / api_key).
        Config: \`METADATA_INSTANCES_CONFIG\` (default \`./config/metadata-instances.json\`).
      security: []
      responses:
        '200':
          description: Public instance list
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/MetadataInstanceListResponse'
              example:
                instances:
                  - instance_id: default
                    name: Community R&D demo instance
                  - instance_id: sre-platform
                    name: SRE platform instance
`;

const metaPaths = META_ACTIONS.map(buildMetaPostPath).join('\n');

const components = `
components:
  parameters:
    TdaiServiceId:
      name: X-Tdai-Service-Id
      in: header
      required: true
      schema:
        type: string
      description: Memory instance ID (= registry id = kernel x-tdai-service-id)
      example: default
    TdaiUserKey:
      name: X-Tdai-User-Key
      in: header
      required: true
      schema:
        type: string
      description: User API key sk-mem-… (auth/verify does not use this Header)
      example: sk-mem-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

  responses:
    ControlBadRequest:
      description: Control validation error (not forwarded to the kernel)
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ApiResponse'
          example:
            code: 400
            message: INVALID_INSTANCE
            request_id: req-example
            data: null
    NotInScope:
      description: Action domains disabled in phase 1 of the new panel (asset / agent-fixed-asset)
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ApiResponse'
          example:
            code: 501
            message: NOT_IN_SCOPE
            request_id: req-example
            data: null
    KernelUnavailable:
      description: Kernel unreachable
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ApiResponse'
          example:
            code: 502
            message: KERNEL_UNAVAILABLE
            request_id: req-example
            data: null
    KernelTimeout:
      description: Kernel timeout
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ApiResponse'
          example:
            code: 504
            message: KERNEL_TIMEOUT
            request_id: req-example
            data: null

  schemas:
    PublicMetadataInstance:
      type: object
      required: [instance_id, name]
      properties:
        instance_id:
          type: string
          description: Memory instance ID (corresponds to kernel x-tdai-service-id)
          example: default
        name:
          type: string
          description: Display name on the login page
          example: Community R&D demo instance

    MetadataInstanceListResponse:
      type: object
      required: [instances]
      properties:
        instances:
          type: array
          items:
            $ref: '#/components/schemas/PublicMetadataInstance'

    ApiResponse:
      type: object
      required: [code, message, request_id, data]
      properties:
        code:
          type: integer
          description: |
            0 = request executed successfully.
            For 400–599, the HTTP status code equals code.
            Check code first for business success/failure; then check data.valid / data.allowed for soft validation.
          example: 0
        message:
          type: string
          example: ok
        request_id:
          type: string
          example: req-a1b2c3d4
        data:
          nullable: true
          description: Success payload; often null on failure

    PaginatedResult:
      type: object
      required: [items, total, limit, offset]
      properties:
        items:
          type: array
          items:
            type: object
            additionalProperties: true
        total:
          type: integer
        limit:
          type: integer
          minimum: 1
          maximum: 100
        offset:
          type: integer
          minimum: 0

    PaginationInput:
      type: object
      properties:
        limit:
          type: integer
          minimum: 1
          maximum: 100
          default: 20
        offset:
          type: integer
          minimum: 0
          default: 0
`;

const yaml = [header, metaPaths, components].join('\n');
writeFileSync(OUT, yaml, 'utf8');
console.log(`Wrote ${OUT} (${META_ACTIONS.length} POST actions + GET instances)`);
