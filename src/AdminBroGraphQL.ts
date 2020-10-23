
import {
    BaseDatabase,
    BaseProperty,
    BaseResource,
    BaseRecord,
    Filter,
    PropertyType,
    ParamsType,
    ForbiddenError
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
    isInputType,
    coerceValue,
    IntrospectionQuery,
    DocumentNode,
    GraphQLFormattedError,
    OperationDefinitionNode,
    FragmentDefinitionNode,
    isWrappingType,
    GraphQLOutputType,
    GraphQLEnumType,
} from "graphql";

import { GraphQLClient } from "./GraphQLClient";

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
        await Promise.all(
            this.resources.map((res) => res as InternalGraphQLResource)
                .map(async (resource) => {
                    const findMapping = resource.findOne(42);
                    let parsed =
                        (typeof findMapping.query === "string")
                            ? parse(findMapping.query)
                            : findMapping.query;
                    const fullSchema = await this.fetchSchema();
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
                                while (isWrappingType(graphQLType)) {
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
                                        isId: namedType.name === "ID",
                                        isSortable: resource.sortableFields?.includes(propertyPath) ?? true,
                                        position: resource.fieldOrder?.indexOf(propertyPath) ?? 0,
                                        referencing: resource.referenceFields?.[propertyPath],
                                        enumValues,
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
                }));
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

export interface GraphQLQueryMapping<T> {
    query: string | DocumentNode;
    variables?: Record<string, unknown>;
    parseResult(result: Record<string, unknown>): T;
}

export interface GraphQLResource {
    id: string;

    sortableFields?: string[];
    fieldOrder?: string[];
    fieldTypeOverrides?: { [field: string]: PropertyType };
    referenceFields?: { [field: string]: string };

    // queries:
    count: (filter: FieldFilter[]) => GraphQLQueryMapping<number>;
    find: (filter: FieldFilter[], options: FindOptions) => GraphQLQueryMapping<ParamsType[]>;
    findOne: (id: string | number) => GraphQLQueryMapping<ParamsType | null>;

    // mutations:
    create?: (record: ParamsType) => GraphQLQueryMapping<ParamsType>;
    update?: (id: string | number, record: ParamsType) => GraphQLQueryMapping<ParamsType>;
    delete?: (id: string | number) => GraphQLQueryMapping<void>;
}

export interface FieldFilter {
    field: string;
    from: string | number | Date;
    to: string | number | Date;
}

export interface FindOptions {
    limit?: number;
    offset?: number;
    sort?: {
        sortBy?: string;
        direction?: "asc" | "desc";
    }
}

type InternalGraphQLResource = GraphQLResource & {
    tag: "GraphQLResource";
    connection?: GraphQLConnection;
    properties?: GraphQLPropertyAdapter[];
    typeMap?: Map<string, GraphQLNamedType>;
}

interface GraphQLResourceMap {
    [key: string]: GraphQLResource
}

class GraphQLResourceAdapter extends BaseResource {
    private readonly connection: GraphQLConnection;
    private readonly propertyMap: Map<string, GraphQLPropertyAdapter>;

    constructor(public readonly rawResource: InternalGraphQLResource) {
        super(rawResource);

        if (!rawResource.connection) {
            throw new Error("Uninitialized resource");
        }
        this.connection = rawResource.connection;
        this.propertyMap = new Map(
            rawResource.properties?.map((prop) => [prop.path(), prop]) ?? []);
    }

    databaseName(): string {
        return this.connection.name;
    }

    databaseType(): string {
        return "graphql";
    }

    id(): string {
        return this.rawResource.id;
    }

    properties(): GraphQLPropertyAdapter[] {
        return [...this.propertyMap.values()];
    }

    property(path: string): GraphQLPropertyAdapter | null {
        return this.propertyMap.get(path) ?? null;
    }

    async populate(records: Array<BaseRecord>, property: BaseProperty): Promise<Array<BaseRecord>> {
        const keys = records.map((record) => record.param(property.name()));

        const subrecords = await this.findMany(keys);
        const recordMap = new Map(subrecords.map((record) => [record.id(), record]));

        return records.map((rec) => {
            const key = rec.param(property.name());
            const subrecord = recordMap.get(key);
            if (subrecord) {
                rec.populated[property.name()] = subrecord;
            }
            return rec;
        });
    }

    async count(filter: Filter): Promise<number> {
        try {
            const fieldFilter = this.mapFilter(filter);
            const mapping = this.rawResource.count(fieldFilter);
            return await this.executeMapping(mapping);
        } catch (error) {
            this.connection.reportAndThrow(error);
        }
    }

    async find(filter: Filter, options: FindOptions): Promise<BaseRecord[]> {
        try {
            const fieldFilter = this.mapFilter(filter);
            const mapping = this.rawResource.find(fieldFilter, options);
            const result = await this.executeMapping(mapping);
            return result.map((record) => new BaseRecord(record, this));
        } catch (error) {
            this.connection.reportAndThrow(error);
        }
    }

    async findOne(id: string | number): Promise<BaseRecord | null> {
        try {
            const mapping = this.rawResource.findOne(id);
            const result = await this.executeMapping(mapping);
            if (result) {
                return new BaseRecord(result, this);
            }
            return null;
        } catch (error) {
            this.connection.reportAndThrow(error);
        }
    }

    async findMany(ids: Array<string | number>): Promise<BaseRecord[]> {
        const resolved = await Promise.all(
            ids.map((id) => this.findOne(id))
        );
        return resolved.filter<BaseRecord>((record): record is BaseRecord => (record != null));
    }

    async create(params: ParamsType): Promise<ParamsType> {
        try {
            const mapping = this.rawResource.create?.(inflateParams(params));
            if (!mapping) {
                throw new ForbiddenError("Resource is not editable");
            }
            return await this.executeMapping(mapping);
        } catch (error) {
            this.connection.reportAndThrow(error);
        }
    }

    async update(id: string, params: ParamsType): Promise<ParamsType> {
        try {
            const mapping = this.rawResource.update?.(id, inflateParams(params));
            if (!mapping) {
                throw new ForbiddenError("Resource is not editable");
            }
            return await this.executeMapping(mapping);
        } catch (error) {
            this.connection.reportAndThrow(error);
        }
    }

    async delete(id: string): Promise<void> {
        try {
            const mapping = this.rawResource.delete?.(id);
            if (!mapping) {
                throw new ForbiddenError("Resource is not editable");
            }
            await this.executeMapping(mapping);
        } catch (error) {
            this.connection.reportAndThrow(error);
        }
    }

    static isAdapterFor(resource: GraphQLResource): boolean {
        const internalResource = resource as InternalGraphQLResource;
        return internalResource.tag == "GraphQLResource";
    }

    private async executeMapping<T = Record<string, unknown>>(mapping: GraphQLQueryMapping<T>): Promise<T> {
        const queryString = typeof mapping.query === "string"
            ? mapping.query
            : mapping.query.loc?.source.body;
        if (!queryString) {
            this.connection.reportAndThrow(new Error("Unexpected parsed query without body"));
        }
        const result = await this.connection.request(queryString, mapping.variables);
        return mapping.parseResult(result);
    }

    private mapFilter(filter: Filter): FieldFilter[] {
        return filter.reduce<FieldFilter[]>((mapped, element) => {
            const from = typeof element.value == "string" ? element.value : element.value.from;
            const to = typeof element.value == "string" ? from : element.value.to;

            const graphQLType = this.rawResource.typeMap?.get(element.path);
            if (!graphQLType || !isInputType(graphQLType)) {
                this.connection.reportAndThrow(
                    new Error(`Cannot get valid GraphQL type from ${this.rawResource.id}:${element.path}`)
                );
            }

            const coercedFrom = coerceValue(from, graphQLType);
            if (coercedFrom.errors?.length) {
                this.connection.reportAndThrow(
                    new Error(`Cannot coerce "from" value from ${from} to ${graphQLType}: ${coercedFrom.errors}`)
                );
            }

            const coercedTo = coerceValue(to, graphQLType);
            if (coercedTo.errors?.length) {
                this.connection.reportAndThrow(
                    new Error(`Cannot coerce "to" value from ${from} to ${graphQLType}: ${coercedTo.errors}`)
                );
            }

            mapped.push({
                field: element.property.path(),
                from: coercedFrom.value,
                to: coercedTo.value,
            });
            return mapped;
        }, []);
    }

}

function inflateParams(params: Record<string, unknown>): Record<string, unknown> {
    const record: Record<string, unknown> = {};

    for (const path of Object.keys(params)) {
        const steps = path.split(".");
        let object = record;
        while (steps.length > 1) {
            const step = steps.shift();
            if (step === undefined) {
                break;
            }
            object[step] = object[step] || {};
            object = object[step] as typeof object;
        }
        object[steps[0]] = params[path];
    }

    return record;
}

interface BasePropertyAttrs {
    path: string;
    type?: PropertyType;
    isId?: boolean;
    isSortable?: boolean;
    position?: number;
}

class GraphQLPropertyAdapter extends BaseProperty {
    private _subProperties: BaseProperty[] = [];
    private _referencing?: string;
    private _enumValues?: string[];

    constructor(property: BasePropertyAttrs & { referencing?: string; enumValues?: string[] }) {
        super(property);
        this._referencing = property.referencing;
        this._enumValues = property.enumValues;
    }

    setSubProperties(properties: BaseProperty[]) {
        this._subProperties = properties;
    }

    subProperties(): BaseProperty[] {
        return this._subProperties;
    }

    reference(): string | null {
        return this._referencing || null;
    }

    availableValues(): string[] | null {
        return this._enumValues ?? super.availableValues();
    }
}

class GraphQLDatabaseAdapter extends BaseDatabase {
    public constructor(public readonly connection: GraphQLConnection) {
        super(connection);
    }

    public resources(): Array<BaseResource> {
        return this.connection.resources
            .map((r) => new GraphQLResourceAdapter(r as InternalGraphQLResource));
    }

    public static isAdapterFor(connection: GraphQLConnection): boolean {
        return connection.tag == "GraphQLConnection";
    }
}

export const GraphQLAdapter = {
    Database: GraphQLDatabaseAdapter,
    Resource: GraphQLResourceAdapter,
};

