/**
 * The iOS scene life cycle plugin (ASK_FOR_QUOTES_PLAN §3).
 *
 * Fixtures are Expo's own templates: the SDK 57 AppDelegate (pre-scene, what
 * `expo prebuild` generates today) and the SDK 58 AppDelegate and
 * SceneDelegate (which adopt scenes). Pinned: the plugin turns the first into
 * exactly the second; running it again changes nothing; a template it does
 * not know is refused loudly at prebuild; the scene manifest names the scene
 * delegate the way the SDK 58 template does.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// The plugin is a CommonJS config plugin run by `expo prebuild`.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const plugin = require('../../plugins/with-scene-lifecycle') as {
  adoptSceneLifecycle: (contents: string) => string;
  SCENE_MANIFEST: Record<string, unknown>;
  SCENE_DELEGATE_SOURCE: string;
};

const fixture = (name: string): string =>
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'scene_lifecycle', name), 'utf8');

it('turns the SDK 57 AppDelegate into exactly the SDK 58 one', () => {
  expect(plugin.adoptSceneLifecycle(fixture('AppDelegate.sdk57.swift.txt'))).toBe(
    fixture('AppDelegate.sdk58.swift.txt'),
  );
});

it('is idempotent, and leaves an AppDelegate that already adopts scenes alone', () => {
  const adopted = fixture('AppDelegate.sdk58.swift.txt');
  expect(plugin.adoptSceneLifecycle(adopted)).toBe(adopted);
  expect(
    plugin.adoptSceneLifecycle(plugin.adoptSceneLifecycle(fixture('AppDelegate.sdk57.swift.txt'))),
  ).toBe(adopted);
});

it('the adopted AppDelegate no longer makes a window, starts React Native or handles links', () => {
  const out = plugin.adoptSceneLifecycle(fixture('AppDelegate.sdk57.swift.txt'));
  expect(out).toContain('class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {');
  expect(out).not.toContain('UIWindow(frame:');
  expect(out).not.toContain('startReactNative');
  expect(out).not.toContain('RCTLinkingManager');
  // The factory is still created: the scene delegate starts React Native with it.
  expect(out).toContain('reactNativeFactory = factory');
});

it('refuses a template it does not know, rather than half-editing it', () => {
  const changed = fixture('AppDelegate.sdk57.swift.txt').replace(
    'window = UIWindow(frame: UIScreen.main.bounds)',
    'window = makeWindow()',
  );
  expect(() => plugin.adoptSceneLifecycle(changed)).toThrow(/does not match the Expo template/);
});

it('the scene delegate is Expo’s, as in the SDK 58 template; the manifest names it', () => {
  // Same class and base as the template's, apart from the comment block.
  const code = (s: string): string =>
    s
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
  expect(code(plugin.SCENE_DELEGATE_SOURCE)).toBe(code(fixture('SceneDelegate.sdk58.swift.txt')));
  expect(plugin.SCENE_MANIFEST).toEqual({
    UIApplicationSupportsMultipleScenes: false,
    UISceneConfigurations: {
      UIWindowSceneSessionRoleApplication: [
        {
          UISceneConfigurationName: 'Default Configuration',
          UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate',
        },
      ],
    },
  });
});
