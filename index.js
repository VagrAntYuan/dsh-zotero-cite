/**
 * DeepSeek Harness bundle: local Zotero library to native Word citation fields.
 *
 * The bundle registers tools only; it starts no server, keeps no state, and talks to nothing but the
 * Zotero instance the user already runs on this machine.
 * @module dsh-zotero-cite
 */

import { TOOLS } from './lib/tools.js'

/** Bundle name, shown in the plugin list. */
export const name = 'dsh-zotero-cite'

/** Services this bundle needs before `apply` runs. */
export const inject = ['tools']

/**
 * Register the Zotero citation tools on the agent's tool registry.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @returns {void}
 */
export function apply(ctx) {
  for (const tool of TOOLS) {
    ctx.tools.register(tool)
  }
}
