
import {
    PropertyType,
} from "admin-bro";

import {
    getIntrospectionQuery,
    buildClientSchema,
    GraphQLSchema,
    parse,
    visit,
    TypeInfo,
    visitWithTypeInfo,
    GraphQLNamedType,
    IntrospectionQuery,
    DocumentNode,
    GraphQLFormattedError,
    OperationDefinitionNode,
    FragmentDefinitionNode,
    isWrappingType,
    GraphQLOutputType,
    GraphQLEnumType,
    GraphQLList,
} from "graphql";

import { GraphQLClient } from "./GraphQLClient";
import { GraphQLPropertyAdapter } from "./GraphQLProperty";
import { InternalGraphQLResource, GraphQLResource } from "./GraphQLResource";

export interface ConnectionOptions {
    name?: string;
    url?: string;
    headers?: () => Record<string, string>;
}

export class GraphQLConnection {
    readonly tag = "GraphQLConnection";
    readonly client: GraphQLClient;
    readonly name: string;
    private readonly headers?: () => Record<string, string>;

    constructor(
        public readonly resources: GraphQLResource[],
        options?: ConnectionOptions,
        private readonly onError?: (error: Error) => void,
    ) {
        this.name = options?.name ?? "graphql";
        const url = options?.url ?? "http://localhost:3000/graphql";
        this.client = new GraphQLClient(url);
        this.headers = options?.headers;
    }

    get r(): GraphQLResourceMap {
        return this.resources.reduce((map: GraphQLResourceMap, resource) => {
            map[resource.id] = resource;
            return map;
        }, {});
    }

    async init(): Promise<void> {
        const fullSchema = await this.fetchSchema();

        this.resources.map((res) => res as InternalGraphQLResource)
            .map((resource) => {
                const findMapping = resource.findOne(42);
                let parsed =
                    (typeof findMapping.query === "string")
                        ? parse(findMapping.query)
                        : findMapping.query;

                const typeInfo = new TypeInfo(fullSchema);
                const path: string[] = [];
                resource.typeMap = new Map();
                resource.connection = this;
                resource.tag = "GraphQLResource";

                parsed = expandFragments(parsed);
                const operationDefinition = parsed.definitions.find((def): def is OperationDefinitionNode => def.kind === "OperationDefinition");
                if (!operationDefinition) {
                    throw new Error("Document without operation is not allowed");
                }
                const toplevelSelections = operationDefinition.selectionSet.selections;
                if (toplevelSelections.length !== 1) {
                    throw new Error("Top level selections must contain exactly one field");
                }
                const topNode = operationDefinition;

                // Initialize with "root" object
                const objectStack: GraphQLPropertyAdapter[][] = [[]];

                visit(topNode, visitWithTypeInfo(typeInfo, {
                    Field: {
                        enter: (field) => {
                            const parentType = typeInfo.getParentType()?.name;
                            if (parentType === "Query" || parentType === "Mutation") {
                                return;
                            }
                            const fieldName = field.name.value;

                            let graphQLType = typeInfo.getType();
                            if (!graphQLType) {
                                throw new Error(`Unexpected empty type for field "${fieldName}" of resource "${resource.id}"`);
                            }

                            let isArray = false;

                            while (isWrappingType(graphQLType)) {
                                if (graphQLType instanceof GraphQLList) {
                                    isArray = true;
                                }
                                graphQLType = graphQLType.ofType as GraphQLOutputType;
                            }
                            const namedType = graphQLType;

                            let enumValues: string[] | undefined;
                            if (namedType instanceof GraphQLEnumType) {
                                enumValues = namedType.getValues().map((val) => val.value);
                            }

                            const propertyPath = [...path, fieldName].join(".");
                            const propertyType =
                                (propertyPath in (resource.referenceFields ?? {}) && "reference") ||
                                resource.fieldTypeOverrides?.[propertyPath] ||
                                (enumValues?.length && "string") ||
                                GraphQLConnection.graphQLTypeToPropertyType(namedType);

                            // Add field to topmost object
                            objectStack[objectStack.length - 1].push(
                                new GraphQLPropertyAdapter({
                                    path: fieldName,
                                    type: propertyType,
                                    isId: namedType.name === "ID" && propertyType !== "reference",
                                    isSortable: resource.sortableFields?.includes(propertyPath) ?? true,
                                    position: resource.fieldOrder?.indexOf(propertyPath) ?? 0,
                                    referencing: resource.referenceFields?.[propertyPath],
                                    enumValues,
                                    isArray
                                })
                            );

                            resource.typeMap?.set(propertyPath, namedType);
                            if (field.selectionSet) {
                                path.push(fieldName);
                                objectStack.push([]);
                            }
                        },
                        leave: (field) => {
                            const parentType = typeInfo.getParentType()?.name;
                            if (parentType === "Query" || parentType === "Mutation") {
                                return;
                            }
                            if (field.selectionSet) {
                                path.pop();
                                const currentObject = objectStack.pop();
                                if (currentObject === undefined) {
                                    throw new Error("Unexpected empty object");
                                }
                                const lastObject = objectStack[objectStack.length - 1];
                                const lastProperty = lastObject[lastObject.length - 1];
                                lastProperty.setSubProperties(currentObject);
                            }
                        }
                    },
                }));

                resource.properties = objectStack.pop();
            });
    }

    private async fetchSchema(): Promise<GraphQLSchema> {
        const query = getIntrospectionQuery({ descriptions: false });
        const result = await this.request<IntrospectionQuery>(query);
        return buildClientSchema(result);
    }

    private static graphQLTypeToPropertyType(graphQLType: GraphQLNamedType): PropertyType {
        switch (graphQLType.name) {
            case "String":
            case "ID":
                return "string";
            case "Float":
                return "float";
            case "Int":
                return "number";
            case "Bool":
                return "boolean";
            case "Date":
                return "datetime";
            default:
                return "mixed";
        }
    }

    private formatGraphQLErrors(errors: GraphQLFormattedError[]): string {
        return "GraphQL request error: " + errors.map((error) => error.message).join(", ");
    }

    async request<T = Record<string, unknown>>(document: string, variables?: Record<string, unknown>): Promise<T> {
        try {
            const headers = this.headers?.();
            const response = await this.client.request<T>(document, variables, headers);
            if (response.errors?.length) {
                this.reportAndThrow(new Error(this.formatGraphQLErrors(response.errors)));
            }
            return response.data;
        } catch (thrown) {
            let error = thrown;
            const graphQLErrors = error.response?.data?.errors;
            if (graphQLErrors) {
                error = new Error(this.formatGraphQLErrors(graphQLErrors));
            }
            this.reportAndThrow(error);
        }
    }

    reportAndThrow(error: Error): never {
        this.onError?.(error);
        throw error;
    }
}

interface GraphQLResourceMap {
    [key: string]: GraphQLResource
}

function expandFragments(node: DocumentNode): DocumentNode {
    const fragmentDefinitions = node.definitions.filter((def): def is FragmentDefinitionNode => def.kind === "FragmentDefinition");

    return visit(node, {
        FragmentSpread: (spread) => {
            const fragment = fragmentDefinitions.find((def) => def.name.value === spread.name.value);
            if (!fragment) {
                throw new Error("Invalid spread reference");
            }
            return fragment.selectionSet;
        }
    });
}
