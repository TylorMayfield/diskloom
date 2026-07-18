import type { DiskloomApi } from './types'

// Production builds alias the development demo module here so representative
// file names and paths never ship in the application bundle.
export const demoApi = undefined as unknown as DiskloomApi
