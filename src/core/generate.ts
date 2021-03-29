import { camel } from "case";
import ts from "typescript";
import { generateIntegrationTests } from "./generateIntegrationTests";
import { generateZodInferredType } from "./generateZodInferredType";
import { generateZodSchemaVariableStatement } from "./generateZodSchema";
import { transformRecursiveSchema } from "./transformRecursiveSchema";

export interface GenerateProps {
  /**
   * Content of the typescript source file.
   */
  sourceText: string;

  /**
   * Max iteration number to resolve the declaration order.
   */
  maxRun?: number;

  /**
   * Filter function on type/interface name.
   */
  nameFilter?: (name: string) => boolean;

  /**
   * Schema name generator.
   */
  getSchemaName?: (identifier: string) => string;

  /**
   * Keep parameters comments.
   * @default false
   */
  keepComments?: boolean;
}

/**
 * Generate zod schemas and integration tests from a typescript file.
 *
 * This function take care of the sorting of the `const` declarations and solved potential circular references
 */
export function generate({
  sourceText,
  maxRun = 10,
  nameFilter = () => true,
  getSchemaName = (id) => camel(id) + "Schema",
  keepComments = false,
}: GenerateProps) {
  // Create a source file
  const sourceFile = ts.createSourceFile(
    "index.ts",
    sourceText,
    ts.ScriptTarget.Latest
  );

  // Extract the nodes (interface declarations & type aliases)
  const nodes: Array<ts.InterfaceDeclaration | ts.TypeAliasDeclaration> = [];

  const visitor = (node: ts.Node) => {
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      if (nameFilter(node.name.text)) {
        nodes.push(node);
      }
    }
  };
  ts.forEachChild(sourceFile, visitor);

  // Generate zod schemas
  const zodSchemas = nodes.map((node) => {
    const typeName = node.name.text;
    const varName = getSchemaName(typeName);
    const zodSchema = generateZodSchemaVariableStatement({
      zodImportValue: "z",
      node,
      sourceFile,
      varName,
      getDependencyName: getSchemaName,
    });

    return { typeName, varName, ...zodSchema };
  });

  // Resolves statements order
  // A schema can't be declared if all the referenced schemas used inside this one are not previously declared.
  const statements = new Map<
    string,
    { typeName: string; value: ts.VariableStatement }
  >();
  const typeImports: Set<string> = new Set();

  let n = 0;
  while (statements.size !== zodSchemas.length && n < maxRun) {
    zodSchemas
      .filter(({ varName }) => !statements.has(varName))
      .forEach(({ varName, dependencies, statement, typeName }) => {
        const isCircular = dependencies.includes(varName);
        const missingDependencies = dependencies
          .filter((dep) => dep !== varName)
          .filter((dep) => !statements.has(dep));
        if (missingDependencies.length === 0) {
          if (isCircular) {
            typeImports.add(typeName);
            statements.set(varName, {
              value: transformRecursiveSchema("z", statement, typeName),
              typeName,
            });
          } else {
            statements.set(varName, { value: statement, typeName });
          }
        }
      });

    n++; // Just a safety net to avoid infinity loops
  }

  // Warn the user of possible not resolvable loops
  const missingStatements = zodSchemas.filter(
    ({ varName }) => !statements.has(varName)
  );

  const errors: string[] = [];

  if (missingStatements.length) {
    errors.push(
      `Some schemas can't be generated due to circular dependencies:
${missingStatements.map(({ varName }) => `${varName}`).join("\n")}`
    );
  }

  // Create output files (zod schemas & integration tests)
  const printer = ts.createPrinter({
    newLine: ts.NewLineKind.LineFeed,
    removeComments: !keepComments,
  });
  const print = (node: ts.Node) =>
    printer.printNode(ts.EmitHint.Unspecified, node, sourceFile);

  const imports = Array.from(typeImports.values());
  const getZodSchemasFile = (
    typesImportPath: string
  ) => `// Generated by ts-to-zod
import { z } from "zod";
${
  imports.length
    ? `import { ${imports.join(", ")} } from "${typesImportPath}";\n`
    : ""
}
${Array.from(statements.values())
  .map((statement) => print(statement.value))
  .join("\n\n")}
`;

  const testCases = generateIntegrationTests(
    Array.from(statements.values()).map((i) => ({
      zodType: `${getSchemaName(i.typeName)}InferredType`,
      tsType: `spec.${i.typeName}`,
    }))
  );

  const getIntegrationTestFile = (
    typesImportPath: string,
    zodSchemasImportPath: string
  ) => `// Generated by ts-to-zod
import { z } from "zod";

import * as spec from "${typesImportPath}";
import * as generated from "${zodSchemasImportPath}";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function expectType<T>(_: T) {
  /* noop */
}

${Array.from(statements.values())
  .map((statement) => {
    // Generate z.infer<>
    const zodInferredSchema = generateZodInferredType({
      aliasName: `${getSchemaName(statement.typeName)}InferredType`,
      zodConstName: `generated.${getSchemaName(statement.typeName)}`,
      zodImportValue: "z",
    });

    return print(zodInferredSchema);
  })
  .join("\n\n")}
${testCases.map(print).join("\n")}
`;

  return {
    /**
     * Get the content of the zod schemas file.
     *
     * @param typesImportPath Relative path of the source file
     */
    getZodSchemasFile,

    /**
     * Get the content of the integration tests file.
     *
     * @param typesImportPath Relative path of the source file
     * @param zodSchemasImportPath Relative path of the zod schemas file
     */
    getIntegrationTestFile,

    /**
     * List of generation errors.
     */
    errors,

    /**
     * `true` if zodSchemaFile have some resolvable circular dependencies
     */
    hasCircularDependencies: imports.length > 0,
  };
}
