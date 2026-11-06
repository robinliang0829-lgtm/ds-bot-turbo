// Resolve synthetic profiles only. This does not create Bots or contact a model.
import { readFile } from 'node:fs/promises'
import { resolveRuntimeProfile } from '../src/shared/runtime-profile.js'

const example = JSON.parse(await readFile(new URL('../../docs/turbo/runtime-profiles.example.json', import.meta.url), 'utf8'))
const plans = example.profiles.map(profile => resolveRuntimeProfile(profile.botId, profile, example.catalog))
console.log(JSON.stringify(plans, null, 2))
