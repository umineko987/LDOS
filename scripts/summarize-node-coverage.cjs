'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { TestCoverage } = require('internal/test_runner/coverage');

const [rawDirectory, temporaryRoot, sourceRoot, outputPath] = process.argv.slice(2);
if (!rawDirectory || !temporaryRoot || !sourceRoot || !outputPath) {
  throw new Error(
    'usage: node --expose-internals summarize-node-coverage.cjs ' +
    '<raw-directory> <temporary-root> <source-root> <output-json>',
  );
}

const groups = ['core', 'apps', 'components'];
const parser = new TestCoverage(rawDirectory, undefined, {
  cwd: temporaryRoot,
  coverageIncludeGlobs: ['gdl_backend/webui/js/**/*.js'],
  coverageExcludeGlobs: [],
  sourceMaps: false,
  lineCoverage: 0,
  branchCoverage: 0,
  functionCoverage: 0,
});
const nativeSummary = parser.summary();
const temporarySourceRoot = path.join(temporaryRoot, 'gdl_backend', 'webui', 'js');

function blankTotals() {
  return {
    totalLineCount: 0,
    totalBranchCount: 0,
    totalFunctionCount: 0,
    coveredLineCount: 0,
    coveredBranchCount: 0,
    coveredFunctionCount: 0,
  };
}

function percentages(totals) {
  const percentage = (covered, total) => total === 0 ? 100 : covered * 100 / total;
  return {
    line: percentage(totals.coveredLineCount, totals.totalLineCount),
    branch: percentage(totals.coveredBranchCount, totals.totalBranchCount),
    function: percentage(totals.coveredFunctionCount, totals.totalFunctionCount),
  };
}

function addFile(totals, file) {
  for (const prefix of ['Line', 'Branch', 'Function']) {
    totals[`total${prefix}Count`] += file[`total${prefix}Count`];
    totals[`covered${prefix}Count`] += file[`covered${prefix}Count`];
  }
}

const groupReports = Object.fromEntries(groups.map((group) => [group, {
  files: [],
  totals: blankTotals(),
}]));
const actualFiles = Object.fromEntries(groups.map((group) => [group, new Set()]));

for (const file of nativeSummary.files) {
  const relative = path.relative(temporarySourceRoot, file.path).split(path.sep).join('/');
  const [group, ...rest] = relative.split('/');
  if (!groups.includes(group) || rest.length !== 1 || !rest[0].endsWith('.js')) {
    throw new Error(`unexpected WebUI coverage path: ${file.path}`);
  }
  const name = rest[0];
  actualFiles[group].add(name);
  const normalized = {
    path: `gallery-dl-backend/gdl_backend/webui/js/${relative}`,
    totalLineCount: file.totalLineCount,
    totalBranchCount: file.totalBranchCount,
    totalFunctionCount: file.totalFunctionCount,
    coveredLineCount: file.coveredLineCount,
    coveredBranchCount: file.coveredBranchCount,
    coveredFunctionCount: file.coveredFunctionCount,
    percentages: {
      line: file.coveredLinePercent,
      branch: file.coveredBranchPercent,
      function: file.coveredFunctionPercent,
    },
  };
  groupReports[group].files.push(normalized);
  addFile(groupReports[group].totals, file);
}

for (const group of groups) {
  const expected = new Set(
    fs.readdirSync(path.join(sourceRoot, group), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
      .map((entry) => entry.name),
  );
  const missing = [...expected].filter((name) => !actualFiles[group].has(name)).sort();
  const unexpected = [...actualFiles[group]].filter((name) => !expected.has(name)).sort();
  if (missing.length || unexpected.length) {
    throw new Error(
      `WebUI ${group} source boundary mismatch: ` +
      `missing=${JSON.stringify(missing)}, unexpected=${JSON.stringify(unexpected)}`,
    );
  }
  groupReports[group].files.sort((left, right) => left.path.localeCompare(right.path));
  groupReports[group].percentages = percentages(groupReports[group].totals);
}

const totals = blankTotals();
for (const group of groups) {
  for (const file of groupReports[group].files) addFile(totals, file);
}

const report = {
  schemaVersion: 1,
  provider: 'Node.js built-in test coverage (V8)',
  node: process.version,
  include: 'gdl_backend/webui/js/**/*.js',
  groups: groupReports,
  totals,
  percentages: percentages(totals),
  explicitOmissions: [
    'gallery-dl-backend/gdl_backend/webui/js/main.js ' +
    '(browser bootstrap outside the requested core/apps/components groups)',
  ],
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
