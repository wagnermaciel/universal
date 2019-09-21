/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import {
  chain,
  externalSchematic,
  Rule,
  SchematicsException,
  noop,
} from '@angular-devkit/schematics';
import {normalize, join, parseJsonAst, JsonParseMode} from '@angular-devkit/core';
import {updateWorkspace} from '@schematics/angular/utility/workspace';
import {
  findPropertyInAstObject,
  appendValueInAstArray,
} from '@schematics/angular/utility/json-utils';
import {relative} from 'path';
import * as ts from 'typescript';

import {Schema as UniversalOptions} from './schema';
import {stripTsExtension, getDistPaths, getClientProject} from './utils';


function addScriptsRule(options: UniversalOptions): Rule {
  return async host => {
    const pkgPath = '/package.json';
    const buffer = host.read(pkgPath);
    if (buffer === null) {
      throw new SchematicsException('Could not find package.json');
    }

    const {server: serverDist} = await getDistPaths(host, options.clientProject);
    const pkg = JSON.parse(buffer.toString());
    pkg.scripts = {
      ...pkg.scripts,
      'serve:ssr': `node ${serverDist}/main.js`,
      'build:ssr': 'npm run build:client-and-server-bundles',
      // tslint:disable-next-line: max-line-length
      'build:client-and-server-bundles': `ng build --prod && ng run ${options.clientProject}:server:production`,
    };

    host.overwrite(pkgPath, JSON.stringify(pkg, null, 2));
  };
}

function updateConfigFileRule(options: UniversalOptions): Rule {
  return host => {
    return updateWorkspace((async workspace => {
      const clientProject = workspace.projects.get(options.clientProject);
      if (clientProject) {
        const buildTarget = clientProject.targets.get('build');
        const serverTarget = clientProject.targets.get('server');

        // We have to check if the project config has a server target, because
        // if the Universal step in this schematic isn't run, it can't be guaranteed
        // to exist
        if (!serverTarget || !buildTarget) {
          return;
        }

        const distPaths = await getDistPaths(host, options.clientProject);

        serverTarget.options = {
          ...serverTarget.options,
          outputPath: distPaths.server,
        };

        serverTarget.options.main = join(
          normalize(clientProject.root),
          stripTsExtension(options.serverFileName) + '.ts',
        );

        buildTarget.options = {
          ...buildTarget.options,
          outputPath: distPaths.browser,
        };
      }
    })) as unknown as Rule;
  };
}

function updateServerTsConfigRule(options: UniversalOptions): Rule {
  return async host => {
    const clientProject = await getClientProject(host, options.clientProject);
    const serverTarget = clientProject.targets.get('server');
    if (!serverTarget || !serverTarget.options) {
      return;
    }

    const tsConfigPath = serverTarget.options.tsConfig;
    if (!tsConfigPath || typeof tsConfigPath !== 'string') {
      // No tsconfig path
      return;
    }

    const configBuffer = host.read(tsConfigPath);
    if (!configBuffer) {
      throw new SchematicsException(`Could not find (${tsConfigPath})`);
    }

    const content = configBuffer.toString();
    const tsConfigAst = parseJsonAst(content, JsonParseMode.Loose);
    if (!tsConfigAst || tsConfigAst.kind !== 'object') {
      throw new SchematicsException(`Invalid JSON AST Object (${tsConfigPath})`);
    }

    const filesAstNode = findPropertyInAstObject(tsConfigAst, 'files');

    if (filesAstNode && filesAstNode.kind === 'array') {
      const recorder = host.beginUpdate(tsConfigPath);

      appendValueInAstArray(
        recorder,
        filesAstNode,
        stripTsExtension(options.serverFileName) + '.ts',
      );

      host.commitUpdate(recorder);
    }
  };
}

function findImportSpecifier(elements: ts.NodeArray<ts.ImportSpecifier>, importName: string) {
  return elements.find(element => {
    const {name, propertyName} = element;
    return propertyName ? propertyName.text === importName : name.text === importName;
  }) || null;
}

function findImport(sourceFile: ts.SourceFile,
                    moduleName: string,
                    symbolName: string): ts.NamedImports | null {
  // Only look through the top-level imports.
  for (const node of sourceFile.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) ||
      node.moduleSpecifier.text !== moduleName) {
      continue;
    }

    const namedBindings = node.importClause && node.importClause.namedBindings;

    if (!namedBindings || !ts.isNamedImports(namedBindings)) {
      continue;
    }

    if (findImportSpecifier(namedBindings.elements, symbolName)) {
      return namedBindings;
    }
  }

  return null;
}

/** Checks whether a node is referring to an import specifier. */
function isReferenceToImport(typeChecker: ts.TypeChecker,
                             node: ts.Node,
                             importSpecifier: ts.ImportSpecifier | null): boolean {
  if (importSpecifier) {
    const nodeSymbol = typeChecker.getTypeAtLocation(node).getSymbol();
    const importSymbol = typeChecker.getTypeAtLocation(importSpecifier).getSymbol();
    return !!(nodeSymbol && importSymbol) &&
      nodeSymbol.valueDeclaration === importSymbol.valueDeclaration;
  }
  return false;
}

function addInitialNavigation(node: ts.CallExpression): ts.CallExpression {
  const existingOptions = node.arguments[1] as ts.ObjectLiteralExpression | undefined;

  // If the user has explicitly set initialNavigation, we respect that
  if (existingOptions && existingOptions.properties.find(exp =>
    ts.isPropertyAssignment(exp) && ts.isIdentifier(exp.name) &&
    exp.name.text === 'initialNavigation')) {
    return node;
  }

  const initialNavigationProperty = ts.createPropertyAssignment('initialNavigation',
    ts.createStringLiteral('enabled'));
  const properties = [initialNavigationProperty];
  const routerOptions = existingOptions ?
    ts.updateObjectLiteral(existingOptions, properties) : ts.createObjectLiteral(properties, true);
  const args = [node.arguments[0], routerOptions];
  return ts.createCall(node.expression, node.typeArguments, args);
}

function routingInitialNavigationRule(options: UniversalOptions): Rule {
  return async host => {
    const clientProject = await getClientProject(host, options.clientProject);
    const serverTarget = clientProject.targets.get('server');
    if (!serverTarget || !serverTarget.options) {
      return;
    }

    const tsConfigPath = serverTarget.options.tsConfig;
    if (!tsConfigPath || typeof tsConfigPath !== 'string') {
      // No tsconfig path
      return;
    }

    const basePath = process.cwd();
    const {config} = ts.readConfigFile(tsConfigPath, ts.sys.readFile);
    const parseConfigHost = {
      useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
      fileExists: ts.sys.fileExists,
      readDirectory: ts.sys.readDirectory,
      readFile: ts.sys.readFile,
    };
    const parsed = ts.parseJsonConfigFileContent(config, parseConfigHost, basePath, {});
    const tsHost = ts.createCompilerHost(parsed.options, true);
    const program = ts.createProgram(parsed.fileNames, parsed.options, tsHost);
    const typeChecker = program.getTypeChecker();
    const printer = ts.createPrinter();
    const sourceFiles = program.getSourceFiles().filter(
      f => !f.isDeclarationFile && !program.isSourceFileFromExternalLibrary(f));
    const routerModule = 'RouterModule';

    sourceFiles.forEach(sourceFile => {
      const routerImport = findImport(sourceFile, '@angular/router', routerModule);
      if (!routerImport) {
        return;
      }

      const importSpecifier = findImportSpecifier(routerImport.elements, routerModule);

      let routerModuleNode: ts.CallExpression;
      ts.forEachChild(sourceFile, function visitNode(node: ts.Node) {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
          isReferenceToImport(typeChecker, node.expression.expression, importSpecifier) &&
          node.expression.name.text === 'forRoot') {
          routerModuleNode = node;
          return;
        }

        ts.forEachChild(node, visitNode);
      });

      if (routerModuleNode) {
        const update = host.beginUpdate(relative(basePath, sourceFile.fileName));
        update.remove(routerModuleNode.getStart(), routerModuleNode.getWidth());
        update.insertRight(
          routerModuleNode.getStart(),
          printer.printNode(
            ts.EmitHint.Unspecified, addInitialNavigation(routerModuleNode),
            sourceFile));

        host.commitUpdate(update);
      }
    });
  };
}

export default function (options: UniversalOptions): Rule {
  return async host => {
    const clientProject = await getClientProject(host, options.clientProject);

    return chain([
      clientProject.targets.has('server')
        ? noop()
        : externalSchematic('@schematics/angular', 'universal', options),
      addScriptsRule(options),
      updateServerTsConfigRule(options),
      updateConfigFileRule(options),
      routingInitialNavigationRule(options),
    ]);
  };
}
