/**
 * The UCP profile host's configuration (UCP plan §3.5, §3.17): the Dina
 * app's claimed OAuth callback link is served only when the app is named,
 * with all three settings together.
 */

import { describe, expect, it } from 'vitest'

import { ucpHostConfig } from '@/ucp/serve.js'

const HOST = 'ucp.test.example'

describe('the app’s claimed-link settings', () => {
  it('none set: no app links served', () => {
    expect(ucpHostConfig({ UCP_PROFILE_HOST: HOST }, false)?.appLinks).toBeUndefined()
  })

  it('all three set: read, lists split on commas', () => {
    expect(
      ucpHostConfig(
        {
          UCP_PROFILE_HOST: HOST,
          UCP_APP_APPLE_IDS: 'TEAM.com.dinakernel.mobile',
          UCP_APP_ANDROID_PACKAGE: 'com.dinakernel.mobile',
          UCP_APP_ANDROID_FINGERPRINTS: 'AA:BB, CC:DD',
        },
        false,
      )?.appLinks,
    ).toEqual({
      appleAppIds: ['TEAM.com.dinakernel.mobile'],
      androidPackage: 'com.dinakernel.mobile',
      androidFingerprints: ['AA:BB', 'CC:DD'],
    })
  })

  it('some but not all: refused at boot', () => {
    expect(() => ucpHostConfig({ UCP_PROFILE_HOST: HOST, UCP_APP_APPLE_IDS: 'T.x' }, false)).toThrow('set together')
  })
})
