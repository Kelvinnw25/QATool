import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * How Apayee's model and effort settings reach its container.
 *
 * They come from `../Apayee/.env` through the service's `env_file`, like every other
 * APAYEE_CLAUDE_* setting. The `environment:` block of that service must NOT name them: an entry
 * there wins over env_file, so a `${APAYEE_CLAUDE_MODEL:-}` written for convenience would be read
 * from QATOOL's own environment, find nothing, and silently blank the operator's setting.
 */
const compose = readFileSync(fileURLToPath(new URL('../../compose.yaml', import.meta.url)), 'utf8');

/** The text of one top-level service: from "  name:" up to the next service. */
function serviceBlock(name) {
  const lines = compose.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.notEqual(start, -1, `service ${name} not found`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {2}[a-z][\w-]*:\s*$/.test(lines[index])) {
      end = index;
      break;
    }
    if (/^[a-z]/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

describe('the apayee service and its model settings', () => {
  const apayee = serviceBlock('apayee');

  it("reads Apayee's own .env, which is where APAYEE_CLAUDE_MODEL and APAYEE_CLAUDE_EFFORT live", () => {
    assert.match(apayee, /^\s+env_file:\s*\.\.\/Apayee\/\.env\s*$/m);
  });

  it('does not override either setting in its environment block', () => {
    const environment =
      /^\s+environment:\s*\n((?:\s+(?:#.*|[A-Z_]+:.*)\n?)+)/m.exec(apayee)?.[1] ?? '';
    assert.doesNotMatch(environment, /APAYEE_CLAUDE_MODEL/);
    assert.doesNotMatch(environment, /APAYEE_CLAUDE_EFFORT/);
    assert.doesNotMatch(environment, /CLAUDE_CODE_EFFORT_LEVEL|ANTHROPIC_MODEL/);
  });

  it('still overrides only the Linux path of the CLI', () => {
    assert.match(apayee, /APAYEE_CLAUDE_CLI_PATH:\s*\/home\/node\/\.local\/bin\/claude/);
  });
});
