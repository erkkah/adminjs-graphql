import { PropertyType } from "adminjs";
import { AxiosError } from "axios";
import { AgentOptions } from "http";

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
    GraphQLObjectType,
    GraphQLID,
    GraphQLType,
    GraphQLNonNull,
} from "graphql";

import { GraphQLClient } from "./GraphQLClient.js";
import { GraphQLPropertyAdapter } from "./GraphQLProperty.js";
import { InternalGraphQLResource, GraphQLResource } from "./GraphQLResource.js";

/**
 * Options for the GraphQL connection.
 * Use `headers` to set api key, et.c.
 */
export interface ConnectionOptions {
    name?: string;
    url?: string;
    headers?: () => Record<string, string>;
    agentOptions?: AgentOptions;
}

/**
 * GraphQLConnection connects to a GraphQL API, and initializes a list of
 * configured resources with data from the remote API schema, so that they
 * can be used as AdminBro resources.
 */
export class GraphQLConnection {
    readonly tag = "GraphQLConnection";
    readonly client: GraphQLClient;
    readonly name: string;
    private readonly headers?: () => Record<string, string>;

    constructor(
        public readonly resources: GraphQLResource[],
        options?: ConnectionOptions,
        private readonly onError?: (
            error: Error,
            originalErrors?: GraphQLFormattedError[]
        ) => void
    ) {
        this.name = options?.name ?? "graphql";
        const url = options?.url ?? "http://localhost:3000/graphql";
        this.client = new GraphQLClient(url, options?.agentOptions);
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
        await this.inflateResources(fullSchema);
    }

    private async fetchSchema(): Promise<GraphQLSchema> {
        const query = getIntrospectionQuery({ descriptions: false });
        const result = await this.request<IntrospectionQuery>(query);
        return buildClientSchema(result);
    }

    private static graphQLTypeToPropertyType(
        graphQLType: GraphQLNamedType
    ): PropertyType {
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

    private async inflateResources(schema: GraphQLSchema) {
        this.resources
            .map((res) => res as InternalGraphQLResource)
            .map((resource) => {
                const findMapping = resource.findOne(42);
                let parsed =
                    typeof findMapping.query === "string"
                        ? parse(findMapping.query)
                        : findMapping.query;

                const typeInfo = new TypeInfo(schema);
                const path: string[] = [];
                resource.typeMap = new Map();
                resource.connection = this;
                resource.tag = "GraphQLResource";

                parsed = expandFragments(parsed);
                const operationDefinition = parsed.definitions.find(
                    (def): def is OperationDefinitionNode =>
                        def.kind === "OperationDefinition"
                );
                if (!operationDefinition) {
                    throw new Error(
                        "Document without operation is not allowed"
                    );
                }
                const toplevelSelections =
                    operationDefinition.selectionSet.selections;
                if (toplevelSelections.length !== 1) {
                    throw new Error(
                        "Top level selections must contain exactly one field"
                    );
                }
                const topNode = operationDefinition;

                // Initialize with "root" object
                const objectStack: GraphQLPropertyAdapter[][] = [[]];
                const propertyMap = new Map<string, GraphQLPropertyAdapter>();

                visit(
                    topNode,
                    visitWithTypeInfo(typeInfo, {
                        Field: {
                            enter: (field) => {
                                const parentType = typeInfo.getParentType();
                                if (
                                    parentType?.name === "Query" ||
                                    parentType?.name === "Mutation"
                                ) {
                                    return;
                                }
                                const fieldName = field.name.value;

                                let graphQLType = typeInfo.getType();
                                if (!graphQLType) {
                                    throw new Error(
                                        `Unexpected empty type for field "${fieldName}" of resource "${resource.id}"`
                                    );
                                }

                                let isArray = false;
                                let isRequired = false;

                                while (isWrappingType(graphQLType)) {
                                    if (graphQLType instanceof GraphQLList) {
                                        isArray = true;
                                    } else if (
                                        graphQLType instanceof GraphQLNonNull &&
                                        !isArray
                                    ) {
                                        isRequired = true;
                                    }
                                    graphQLType =
                                        graphQLType.ofType as GraphQLOutputType;
                                }
                                const namedType = graphQLType;

                                let enumValues: string[] | undefined;
                                if (namedType instanceof GraphQLEnumType) {
                                    enumValues = namedType
                                        .getValues()
                                        .map((val) => val.value);
                                }

                                const parentPath = path.join(".");
                                const propertyPath = [...path, fieldName].join(
                                    "."
                                );

                                let propertyType: PropertyType | undefined;
                                let referencing: string | undefined;

                                if (namedType instanceof GraphQLObjectType) {
                                    const objectFields = namedType.getFields();
                                    const selections =
                                        field.selectionSet?.selections ?? [];
                                    if (
                                        selections.length === 1 &&
                                        selections[0].kind === "Field"
                                    ) {
                                        const fieldName =
                                            selections[0].name.value;
                                        const objectField =
                                            objectFields[fieldName];
                                        if (!objectField) {
                                            throw new Error(
                                                `Field ${fieldName} is not in ${namedType.name}`
                                            );
                                        }
                                        const fieldType = objectField.type;
                                        if (typeIsID(fieldType)) {
                                            propertyType = "reference";
                                            referencing = namedType.name;
                                        }
                                    }
                                }

                                if (!propertyType) {
                                    propertyType =
                                        (propertyPath in
                                            (resource.referenceFields ?? {}) &&
                                            "reference") ||
                                        (enumValues?.length && "string") ||
                                        GraphQLConnection.graphQLTypeToPropertyType(
                                            namedType
                                        );
                                }

                                const isSortable = resource.sortableFields
                                    ? resource.sortableFields.includes(
                                          propertyPath
                                      )
                                    : propertyType != "reference";

                                const parentProperty =
                                    propertyMap.get(parentPath);
                                const useFullPath =
                                    !resource.makeSubproperties &&
                                    !(
                                        parentProperty?.type() === "mixed" &&
                                        parentProperty?.isArray()
                                    );

                                const property = new GraphQLPropertyAdapter({
                                    path: useFullPath
                                        ? propertyPath
                                        : fieldName,
                                    type: propertyType,
                                    isId:
                                        namedType.name === "ID" &&
                                        propertyType !== "reference",
                                    isSortable: isSortable,
                                    referencing:
                                        referencing ??
                                        resource.referenceFields?.[
                                            propertyPath
                                        ],
                                    enumValues,
                                    isArray,
                                    isRequired,
                                });

                                objectStack[objectStack.length - 1].push(
                                    property
                                );
                                propertyMap.set(propertyPath, property);
                                resource.typeMap?.set(propertyPath, namedType);

                                if (field.selectionSet) {
                                    path.push(fieldName);
                                    objectStack.push([]);
                                }
                            },
                            leave: (field) => {
                                const parentType =
                                    typeInfo.getParentType()?.name;
                                if (
                                    parentType === "Query" ||
                                    parentType === "Mutation"
                                ) {
                                    return;
                                }
                                if (field.selectionSet) {
                                    path.pop();
                                    const currentObject = objectStack.pop();
                                    if (currentObject === undefined) {
                                        throw new Error(
                                            "Unexpected empty object"
                                        );
                                    }
                                    const lastObject =
                                        objectStack[objectStack.length - 1];
                                    const lastProperty =
                                        lastObject[lastObject.length - 1];

                                    if (
                                        lastProperty &&
                                        ((lastProperty.type() === "mixed" &&
                                            lastProperty.isArray()) ||
                                            resource.makeSubproperties)
                                    ) {
                                        lastProperty.setSubProperties(
                                            currentObject
                                        );
                                    } else if (
                                        currentObject.length !== 1 ||
                                        !currentObject[0].isId()
                                    ) {
                                        lastObject.push(...currentObject);
                                    }
                                }
                            },
                        },
                    })
                );

                resource.properties = objectStack
                    .pop()
                    ?.filter(
                        (prop) =>
                            prop.type() !== "mixed" ||
                            prop.subProperties().length
                    );
            });
    }

    private formatGraphQLErrors(errors: GraphQLFormattedError[]): string {
        return (
            "GraphQL request error: " +
            errors.map((error) => error.message).join(", ")
        );
    }

    async request<T = Record<string, unknown>>(
        document: string,
        variables?: Record<string, unknown>
    ): Promise<T> {
        try {
            const headers = this.headers?.();
            const response = await this.client.request<T>(
                document,
                variables,
                headers
            );
            if (response.errors?.length) {
                this.reportAndThrow(
                    new Error(this.formatGraphQLErrors(response.errors)),
                    response.errors
                );
            }
            return response.data;
        } catch (thrown) {
            let error = thrown as Error;
            const axiosError = error as AxiosError;
            // @ts-ignore
            const graphQLErrors = axiosError.response?.data?.errors;
            if (graphQLErrors) {
                error = new Error(this.formatGraphQLErrors(graphQLErrors));
            }
            this.reportAndThrow(error, graphQLErrors);
        }
    }

    reportAndThrow(
        error: Error,
        originalErrors?: GraphQLFormattedError[]
    ): never {
        this.onError?.(error, originalErrors);
        throw error;
    }
}

interface GraphQLResourceMap {
    [key: string]: GraphQLResource;
}

function expandFragments(node: DocumentNode): DocumentNode {
    const fragmentDefinitions = node.definitions.filter(
        (def): def is FragmentDefinitionNode =>
            def.kind === "FragmentDefinition"
    );

    return visit(node, {
        FragmentSpread: (spread) => {
            const fragment = fragmentDefinitions.find(
                (def) => def.name.value === spread.name.value
            );
            if (!fragment) {
                throw new Error("Invalid spread reference");
            }
            return fragment.selectionSet;
        },
    });
}

function typeIsID(fieldType: GraphQLType): boolean {
    while (isWrappingType(fieldType)) {
        fieldType = fieldType.ofType;
    }
    return fieldType === GraphQLID;
}
