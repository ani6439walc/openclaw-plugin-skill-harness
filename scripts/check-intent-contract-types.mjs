#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import ts from "typescript";

function parseArgs(argv) {
  const projectIndex = argv.indexOf("--project");
  if (projectIndex === -1 || !argv[projectIndex + 1]) {
    throw new Error("Usage: node scripts/check-intent-contract-types.mjs --project <tsconfig.json> [--list-files]");
  }
  return {
    listFiles: argv.includes("--list-files"),
    project: path.resolve(argv[projectIndex + 1]),
  };
}

function loadProgram(project) {
  const readResult = ts.readConfigFile(project, ts.sys.readFile);
  if (readResult.error) {
    throw new Error(ts.flattenDiagnosticMessageText(readResult.error.messageText, "\n"));
  }
  const parsed = ts.parseJsonConfigFileContent(
    readResult.config,
    ts.sys,
    path.dirname(project),
    { noEmit: true },
    project,
  );
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n"));
  }
  return ts.createProgram({ options: parsed.options, rootNames: parsed.fileNames });
}

function resolveAlias(checker, symbol) {
  let current = symbol;
  const seen = new Set();
  while (current && (current.flags & ts.SymbolFlags.Alias) && !seen.has(current)) {
    seen.add(current);
    current = checker.getAliasedSymbol(current);
  }
  return current;
}

function contractSymbols(program, checker) {
  const found = new Map();
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) continue;
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      if (exported.name !== "IntentDefinition" && exported.name !== "IntentCatalogEntry") continue;
      found.set(exported.name, resolveAlias(checker, exported));
    }
  }
  if (found.size !== 2) {
    throw new Error("Could not resolve exported IntentDefinition and IntentCatalogEntry contract symbols");
  }
  return found;
}

function locationOf(node, projectDirectory) {
  const sourceFile = node.getSourceFile();
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${path.relative(projectDirectory, sourceFile.fileName) || path.basename(sourceFile.fileName)}:${position.line + 1}:${position.character + 1}`;
}

function isUnsafeType(type) {
  return Boolean(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
}

function typeArguments(checker, type) {
  try {
    return checker.getTypeArguments(type);
  } catch {
    return type.aliasTypeArguments ?? [];
  }
}

function isContractType(checker, type, symbols, seen = new Set()) {
  if (!type || seen.has(type)) return false;
  seen.add(type);
  const symbol = type.aliasSymbol ?? type.getSymbol?.();
  if (symbol && symbols.has(resolveAlias(checker, symbol))) return true;
  if (type.isUnionOrIntersection?.()) {
    return type.types.some((member) => isContractType(checker, member, symbols, seen));
  }
  return typeArguments(checker, type).some((argument) => isContractType(checker, argument, symbols, seen));
}

function propertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function enclosingContractFunction(checker, node, symbols) {
  for (let current = node.parent; current; current = current.parent) {
    if (!ts.isFunctionLike(current)) continue;
    const signature = checker.getSignatureFromDeclaration(current);
    if (signature && isContractType(checker, checker.getReturnTypeOfSignature(signature), symbols)) {
      return current;
    }
    return undefined;
  }
  return undefined;
}

function variableInitializer(checker, expression) {
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = checker.getSymbolAtLocation(expression);
  const declaration = symbol && resolveAlias(checker, symbol).valueDeclaration;
  return declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined;
}

function run(project, { listFiles }) {
  const program = loadProgram(project);
  const checker = program.getTypeChecker();
  const symbols = new Set(contractSymbols(program, checker).values());
  const projectDirectory = path.dirname(project);
  const violations = [];
  const reported = new Set();
  const flowNodes = [];

  function report(node, message) {
    const key = `${node.getSourceFile().fileName}:${node.getStart()}:${message}`;
    if (reported.has(key)) return;
    reported.add(key);
    violations.push({ node, message });
  }

  function inspectType(type, node, nestedInFastpath, seenTypes = new Set()) {
    if (!type || seenTypes.has(type)) return;
    seenTypes.add(type);
    if (isUnsafeType(type)) {
      report(node, "any or unknown cannot bypass the intent contract");
      return;
    }
    for (const property of checker.getPropertiesOfType(type)) {
      if (property.name === "prompt") {
        report(node, "legacy prompt property is not allowed in an intent contract flow");
      }
      if (nestedInFastpath && property.name === "hint") {
        report(node, "legacy fastpath.hint property is not allowed in an intent contract flow");
      }
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      if (!declaration) continue;
      const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration);
      inspectType(propertyType, declaration, nestedInFastpath || property.name === "fastpath", seenTypes);
    }
  }

  function inspectExpression(expression, nestedInFastpath = false, seenExpressions = new Set()) {
    while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
    if (seenExpressions.has(expression)) return;
    seenExpressions.add(expression);

    if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) {
      report(expression, "type assertion cannot bypass the intent contract");
      inspectExpression(expression.expression, nestedInFastpath, seenExpressions);
      return;
    }
    if (ts.isSatisfiesExpression(expression)) {
      inspectExpression(expression.expression, nestedInFastpath, seenExpressions);
      return;
    }

    const type = checker.getTypeAtLocation(expression);
    inspectType(type, expression, nestedInFastpath);

    const initializer = variableInitializer(checker, expression);
    if (initializer) inspectExpression(initializer, nestedInFastpath, seenExpressions);

    if (ts.isObjectLiteralExpression(expression)) {
      for (const property of expression.properties) {
        if (ts.isSpreadAssignment(property)) {
          inspectExpression(property.expression, nestedInFastpath, seenExpressions);
          continue;
        }
        const name = propertyName(property.name);
        const inFastpath = nestedInFastpath || name === "fastpath";
        if (name === "prompt") report(property.name, "legacy prompt property is not allowed in an intent contract flow");
        if (nestedInFastpath && name === "hint") {
          report(property.name, "legacy fastpath.hint property is not allowed in an intent contract flow");
        }
        if (ts.isPropertyAssignment(property)) {
          inspectExpression(property.initializer, inFastpath, seenExpressions);
        } else if (ts.isShorthandPropertyAssignment(property)) {
          inspectExpression(property.name, inFastpath, seenExpressions);
        }
      }
    } else if (ts.isArrayLiteralExpression(expression)) {
      for (const element of expression.elements) inspectExpression(element, nestedInFastpath, seenExpressions);
    }
  }

  function inspectFlow(expression, target, owner) {
    const flow = owner ?? expression;
    flowNodes.push(flow);
    let statement = flow;
    while (statement.parent && !ts.isStatement(statement)) {
      statement = statement.parent;
    }
    const sourceFile = statement.getSourceFile();
    const leadingText = sourceFile.text.slice(
      statement.getFullStart(),
      statement.getStart(sourceFile),
    );
    if (/\/\/\s*@ts-(?:ignore|expect-error)\b|\/\*\s*@ts-(?:ignore|expect-error)\b/.test(leadingText)) {
      report(flow, "suppression directive cannot bypass the intent contract");
    }
    const source = checker.getTypeAtLocation(expression);
    if (isUnsafeType(source)) {
      report(expression, "any or unknown cannot bypass the intent contract");
    } else if (!checker.isTypeAssignableTo(source, target)) {
      report(expression, `value is not assignable to ${checker.typeToString(target)}`);
    }
    inspectExpression(expression);
  }

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile || sourceFile.fileName.includes("/node_modules/")) continue;
    function visit(node) {
      if (ts.isVariableDeclaration(node) && node.initializer && node.type) {
        const target = checker.getTypeFromTypeNode(node.type);
        if (isContractType(checker, target, symbols)) inspectFlow(node.initializer, target, node);
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const target = checker.getTypeAtLocation(node.left);
        if (isContractType(checker, target, symbols)) inspectFlow(node.right, target, node);
      }
      if (ts.isReturnStatement(node) && node.expression) {
        const functionNode = enclosingContractFunction(checker, node, symbols);
        if (functionNode) {
          const signature = checker.getSignatureFromDeclaration(functionNode);
          inspectFlow(node.expression, checker.getReturnTypeOfSignature(signature), node);
        }
      }
      if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments) {
        const signature = checker.getResolvedSignature(node);
        const parameters = signature?.getParameters() ?? [];
        for (let index = 0; index < node.arguments.length; index += 1) {
          const parameter = parameters[Math.min(index, parameters.length - 1)];
          if (!parameter) continue;
          const declaration = parameter.valueDeclaration ?? parameter.declarations?.[0] ?? node;
          const target = checker.getTypeOfSymbolAtLocation(parameter, declaration);
          if (isContractType(checker, target, symbols)) inspectFlow(node.arguments[index], target, node.arguments[index]);
        }
      }
      if (ts.isSatisfiesExpression(node)) {
        const target = checker.getTypeFromTypeNode(node.type);
        if (isContractType(checker, target, symbols)) inspectFlow(node.expression, target, node);
      }
      if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && isContractType(checker, checker.getTypeFromTypeNode(node.type), symbols)) {
        inspectFlow(node, checker.getTypeFromTypeNode(node.type), node);
      }
      if (ts.isObjectLiteralExpression(node)) {
        const target = checker.getContextualType(node);
        if (target && isContractType(checker, target, symbols)) inspectFlow(node, target, node);
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }

  const diagnostics = program.getSemanticDiagnostics();
  for (const diagnostic of diagnostics) {
    if (!diagnostic.file || diagnostic.start === undefined) continue;
    const isInFlow = flowNodes.some((flow) =>
      flow.getSourceFile() === diagnostic.file &&
      diagnostic.start >= flow.getStart(diagnostic.file) &&
      diagnostic.start <= flow.getEnd(),
    );
    if (isInFlow) report(ts.getTokenAtPosition(diagnostic.file, diagnostic.start), ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));
  }

  if (listFiles) {
    for (const sourceFile of program.getSourceFiles()) {
      if (!sourceFile.isDeclarationFile && !sourceFile.fileName.includes("/node_modules/")) {
        console.log(path.relative(projectDirectory, sourceFile.fileName));
      }
    }
  }
  for (const violation of violations) {
    console.error(`${locationOf(violation.node, projectDirectory)}: contract violation: ${violation.message}`);
  }
  return violations.length === 0 ? 0 : 1;
}

try {
  const args = parseArgs(process.argv.slice(2));
  process.exitCode = run(args.project, args);
} catch (error) {
  console.error(`intent contract checker error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
