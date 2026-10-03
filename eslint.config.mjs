import { FlatCompat } from '@eslint/eslintrc';
import js from '@eslint/js';
import eslintComments from '@eslint-community/eslint-plugin-eslint-comments';
import nextPlugin from '@next/eslint-plugin-next';
// eslint-disable-next-line import/no-unresolved -- Node는 ESLint의 exports 경로를 읽지만 기본 import 해석기는 해당 경로를 찾지 못합니다.
import { builtinRules } from 'eslint/use-at-your-own-risk';
import eslintConfigPrettier from 'eslint-config-prettier';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import sonarjs from 'eslint-plugin-sonarjs';
import globals from 'globals';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const configDirectory = path.dirname(fileURLToPath(import.meta.url));
const TEST_FILES = ['**/*.test.*'];
const WEB_FILES = ['apps/web/**/*.{js,jsx,mjs}'];
const webConfigs = [
  react.configs.flat.recommended,
  react.configs.flat['jsx-runtime'],
  reactHooks.configs.flat.recommended,
  nextPlugin.configs['core-web-vitals'],
].map((config) => ({ ...config, files: WEB_FILES }));
const compat = new FlatCompat({
  baseDirectory: configDirectory,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

// lift의 루트 기본 규칙과 웹의 선언형·코드 품질 규칙을 가져옵니다.
const declarativeFunctionalRules = {
  'no-param-reassign': ['warn', { props: true }],
  'no-plusplus': 'warn',
  'no-restricted-syntax': [
    'error',
    {
      selector: 'ForStatement',
      message: 'for 대신 map/filter/reduce 같은 값 변환을 사용합니다.',
    },
    {
      selector: 'ForInStatement',
      message: 'for...in 대신 Object.entries 계열을 사용합니다.',
    },
    {
      selector: 'ForOfStatement',
      message: 'for...of 대신 배열 메서드와 값 변환을 사용합니다.',
    },
    {
      selector: 'WhileStatement',
      message: 'while 대신 종료 조건이 드러나는 값 변환을 사용합니다.',
    },
    {
      selector: 'DoWhileStatement',
      message: 'do...while 대신 종료 조건이 드러나는 값 변환을 사용합니다.',
    },
    {
      selector: "AssignmentExpression[left.type='MemberExpression']",
      message: '객체와 배열을 직접 바꾸기보다 새 값을 반환합니다.',
    },
    {
      selector: "CallExpression[callee.type='MemberExpression'][callee.property.name=/^(then|catch)$/]",
      message: 'Promise 체이닝 대신 await와 try/catch를 사용합니다.',
    },
  ],
  'no-var': 'warn',
  'prefer-const': 'warn',
};

// lift와 같이 목표값과 상한을 구분합니다. lint 명령은 경고도 실패로 처리합니다.
const codeHealthCeilingRules = {
  'stt/complexity': ['error', { max: 15 }],
  'stt/max-lines-per-function': [
    'error',
    { max: 200, skipBlankLines: true, skipComments: true, IIFEs: true },
  ],
  'stt/max-lines': ['error', { max: 900, skipBlankLines: true, skipComments: true }],
};

const codeHealthRules = {
  complexity: ['warn', { max: 10 }],
  'max-depth': ['warn', 3],
  'max-params': ['error', 5],
  'max-lines-per-function': [
    'warn',
    { max: 120, skipBlankLines: true, skipComments: true, IIFEs: true },
  ],
  'max-lines': ['warn', { max: 600, skipBlankLines: true, skipComments: true }],
  'sonarjs/no-duplicate-string': ['error', { threshold: 3 }],
  '@eslint-community/eslint-comments/require-description': ['error', { ignore: [] }],
};

export default [
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.next/**', 'assets/**', 'output/**'] },
  ...compat.extends('airbnb-base'),
  eslintConfigPrettier,
  {
    files: ['**/*.{js,jsx,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: { ...globals.node },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    plugins: {
      '@eslint-community/eslint-comments': eslintComments,
      sonarjs,
      stt: {
        rules: {
          complexity: builtinRules.get('complexity'),
          'max-lines': builtinRules.get('max-lines'),
          'max-lines-per-function': builtinRules.get('max-lines-per-function'),
        },
      },
    },
    settings: { 'import/resolver': { node: true } },
    rules: {
      'import/extensions': ['error', 'ignorePackages', { js: 'never', jsx: 'never', mjs: 'never', cjs: 'never' }],
      'import/first': 'error',
      'import/newline-after-import': 'error',
      'import/no-duplicates': 'error',
      'import/order': [
        'error',
        {
          alphabetize: { caseInsensitive: true, order: 'asc' },
          groups: [['builtin', 'external'], ['internal'], ['parent', 'sibling', 'index'], ['object', 'type']],
          'newlines-between': 'always',
        },
      ],
      'import/prefer-default-export': 'off',
      'arrow-parens': ['error', 'always'],
      curly: ['error', 'all'],
      'no-unexpected-multiline': 'error',
      camelcase: 'off',
      'no-continue': 'off',
      'no-console': 'off',
      'no-underscore-dangle': 'off',
      'prefer-destructuring': 'off',
      ...declarativeFunctionalRules,
      ...codeHealthRules,
      ...codeHealthCeilingRules,
    },
  },
  {
    files: ['**/*.{js,cjs}'],
    languageOptions: { sourceType: 'commonjs' },
  },
  // Next의 권장 방식에 따라 플러그인을 직접 연결해 Airbnb의 import 설정을 유지합니다.
  ...webConfigs,
  {
    files: WEB_FILES,
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      sourceType: 'module',
    },
    settings: {
      next: { rootDir: path.join(configDirectory, 'apps/web') },
      react: { version: 'detect' },
      'import/resolver': { node: { extensions: ['.js', '.jsx', '.mjs', '.json', '.node'] } },
    },
    rules: {
      // Next와 lift의 설정처럼 컴포넌트 입력에는 실행 중 propTypes 검사를 요구하지 않습니다.
      'react/prop-types': 'off',
    },
  },
  {
    // 서버 모듈은 Next와 Node의 직접 실행 검사에서 같은 ESM 경로를 사용합니다.
    files: ['apps/web/src/server/**/*.js', 'apps/web/src/app/api/**/*.js', 'apps/web/src/instrumentation.js', 'apps/web/test/**/*.js'],
    rules: { 'import/extensions': ['error', 'ignorePackages', { js: 'always' }] },
  },
  {
    // lift의 테스트 예외를 유지하되 선언형 규칙과 우회 사유 요구는 그대로 적용합니다.
    files: TEST_FILES,
    rules: {
      'sonarjs/no-duplicate-string': 'off',
      complexity: 'off',
      'stt/complexity': 'off',
      'stt/max-lines': 'off',
      'stt/max-lines-per-function': 'off',
      'max-depth': 'off',
      'max-lines': 'off',
      'max-lines-per-function': 'off',
      'max-params': 'off',
    },
  },
  {
    files: ['eslint.config.mjs', '**/*.config.{js,mjs,cjs}', ...TEST_FILES],
    rules: {
      'import/no-extraneous-dependencies': [
        'error',
        { devDependencies: ['eslint.config.mjs', '**/*.config.{js,mjs,cjs}', ...TEST_FILES] },
      ],
    },
  },
];
