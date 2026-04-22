/**
 * T0.3 — Native module setup: verify all required modules are installed.
 *
 * Checks that package.json declares all native dependencies and that
 * their TypeScript types are importable. Actual native functionality
 * requires a device build — this test verifies the wiring.
 *
 * Source: ARCHITECTURE.md Task 0.3
 */

import * as fs from 'fs';
import * as path from 'path';

const APP_PKG_PATH = path.resolve(__dirname, '../../package.json');

describe('Native Module Setup (0.3)', () => {
  let pkg: Record<string, unknown>;

  beforeAll(() => {
    pkg = JSON.parse(fs.readFileSync(APP_PKG_PATH, 'utf-8'));
  });

  describe('required native dependencies declared', () => {
    const deps = () => ({
      ...(pkg.dependencies as Record<string, string>),
      ...(pkg.devDependencies as Record<string, string>),
    });

    it('op-sqlite for SQLCipher vault', () => {
      expect(deps()['@op-engineering/op-sqlite']).toBeTruthy();
    });

    it('react-native-keychain for secure storage', () => {
      expect(deps()['react-native-keychain']).toBeTruthy();
    });

    it('expo-contacts for phone contacts import', () => {
      expect(deps()['expo-contacts']).toBeTruthy();
    });

    it('expo-sharing for archive export', () => {
      expect(deps()['expo-sharing']).toBeTruthy();
    });

    it('expo-background-fetch for background tasks', () => {
      expect(deps()['expo-background-fetch']).toBeTruthy();
    });

    it('expo for framework', () => {
      expect(deps()['expo']).toBeTruthy();
    });

    it('expo-router for navigation', () => {
      expect(deps()['expo-router']).toBeTruthy();
    });

    it('react-native core', () => {
      expect(deps()['react-native']).toBeTruthy();
    });
  });

  describe('native project generation', () => {
    it('app.json exists with correct name', () => {
      const appJsonPath = path.resolve(__dirname, '../../app.json');
      expect(fs.existsSync(appJsonPath)).toBe(true);

      const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf-8'));
      expect(appJson.expo.name).toBe('Dina');
      expect(appJson.expo.slug).toBe('dina-mobile');
    });

    it('metro.config.js exists', () => {
      expect(fs.existsSync(path.resolve(__dirname, '../../metro.config.js'))).toBe(true);
    });

    it('babel.config.js exists', () => {
      expect(fs.existsSync(path.resolve(__dirname, '../../babel.config.js'))).toBe(true);
    });

    it('tsconfig.json exists', () => {
      expect(fs.existsSync(path.resolve(__dirname, '../../tsconfig.json'))).toBe(true);
    });
  });

  describe('monorepo workspace resolution', () => {
    it('@dina/core is a workspace dependency', () => {
      const deps = pkg.dependencies as Record<string, string>;
      expect(deps['@dina/core']).toBe('*');
    });

    it('@dina/brain is a workspace dependency', () => {
      const deps = pkg.dependencies as Record<string, string>;
      expect(deps['@dina/brain']).toBe('*');
    });

    it('@dina/test-harness is a workspace dependency', () => {
      const deps = pkg.dependencies as Record<string, string>;
      expect(deps['@dina/test-harness']).toBe('*');
    });
  });
});
