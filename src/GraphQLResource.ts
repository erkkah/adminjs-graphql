import {
    DocumentNode,
    GraphQLNamedType,
    isInputType,
    GraphQLScalarType,
    GraphQLObjectType,
    GraphQLID,
    GraphQLType,
} from "graphql";
import {
    ParamsType,
    BaseResource,
    BaseRecord,
    Filter,
    ForbiddenError,
    ValidationError,
    PropertyErrors,
} from "adminjs";

import { GraphQLConnection } from "./index.js";
import { GraphQLPropertyAdapter } from "./GraphQLProperty.js";

/**
 * The actual GraphQL query/mutation that will be called to
 * interact with the remote API.
 */
export interface GraphQLQueryMapping<T> {
    // GQL code to pass to the API
    query: string | DocumentNode;
    // Variables to parametrize the query
    variables?: Record<string, unknown>;
    // Converts the record returned from the API
    // to the type needed for the mapped operation.
    parseResult(result: Record<string, unknown>): T;
}

/**
 * Pagination and sorting options passed to the find operation.
 */
export interface FindOptions {
    limit?: number;
    offset?: number;
    sort?: {
        sortBy?: string;
        direction?: "asc" | "desc";
    };
}

/**
 * GraphQLResource is the definition of how a GraphQL resource
 * is mapped to an AdminBro resource.
 */
export interface GraphQLResource {
    // Resource id, typically a GraphQL defined type
    id: string;

    // List of all fields that the resource can be sorted by
    sortableFields?: string[];

    // List of fields that are reference fields.
    // By default, ID fields are treated as references.
    referenceFields?: { [field: string]: string };

    // Set to true to make subproperties for object fields.
    makeSubproperties?: boolean;

    // Returns a query mapping providing the number of entities matching the filter.
    count: (filter: FieldFilter[]) => GraphQLQueryMapping<number>;

    // Returns a query mapping providing a list of entities matching
    // the specified filter and options.
    find: (
        filter: FieldFilter[],
        options: FindOptions
    ) => GraphQLQueryMapping<ParamsType[]>;

    // Returns a query mapping for retrieving the specified record.
    findOne: (id: string | number) => GraphQLQueryMapping<ParamsType | null>;

    // Returns a query mapping for creating a record using the provided entity.
    create?: (record: ParamsType) => GraphQLQueryMapping<ParamsType>;

    // Returns a query mapping for updating a specified record.
    update?: (
        id: string | number,
        record: ParamsType
    ) => GraphQLQueryMapping<ParamsType>;

    // Returns a query mapping for deleting a specified record.
    delete?: (id: string | number) => GraphQLQueryMapping<void>;
}

/**
 * Filter operations for use in field filters.
 * `MATCH` performs implementation (API) specific matching, and is used
 * for filtering on string fields.
 */
export type FilterOperation = "GTE" | "LTE" | "EQ" | "MATCH";

/**
 * A filtering operation.
 * The "than" and "to" fields specify the compare operand to the
 * filter operation.
 */
export interface FieldFilter {
    field: string;
    is: FilterOperation;
    than?: unknown;
    to?: unknown;
}

export type InternalGraphQLResource = GraphQLResource & {
    tag: "GraphQLResource";
    connection?: GraphQLConnection;
    properties?: GraphQLPropertyAdapter[];
    typeMap?: Map<string, GraphQLNamedType>;
};

export class GraphQLResourceAdapter extends BaseResource {
    private readonly connection: GraphQLConnection;
    private readonly propertyMap: Map<string, GraphQLPropertyAdapter>;

    constructor(public readonly rawResource: InternalGraphQLResource) {
        super(rawResource);

        if (!rawResource.connection) {
            throw new Error("Uninitialized resource");
        }
        this.connection = rawResource.connection;
        this.propertyMap = new Map(
            rawResource.properties?.map((prop) => [prop.path(), prop]) ?? []
        );
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

    async count(filter: Filter): Promise<number> {
        try {
            const fieldFilter = this.mapFilter(filter);
            const mapping = this.rawResource.count(fieldFilter);
            return await this.executeMapping(mapping);
        } catch (error) {
            this.connection.reportAndThrow(error as Error);
        }
    }

    async find(filter: Filter, options: FindOptions): Promise<BaseRecord[]> {
        try {
            const fieldFilter = this.mapFilter(filter);
            const mapping = this.rawResource.find(fieldFilter, options);
            const result = await this.executeMapping(mapping);
            return result.map((record) => new BaseRecord(record, this));
        } catch (error) {
            this.connection.reportAndThrow(error as Error);
        }
    }

    async findOne(id: string | number): Promise<BaseRecord | null> {
        try {
            const mapping = this.rawResource.findOne(deflateReference(id));
            const result = await this.executeMapping(mapping);
            if (result) {
                return new BaseRecord(result, this);
            }
            return null;
        } catch (error) {
            this.connection.reportAndThrow(error as Error);
        }
    }

    async findMany(ids: Array<string | number>): Promise<BaseRecord[]> {
        const resolved = await Promise.all(ids.map((id) => this.findOne(id)));
        return resolved.filter<BaseRecord>(
            (record): record is BaseRecord => record != null
        );
    }

    private convertParams(params: ParamsType): ParamsType {
        const converted = Object.keys(params).reduce((coerced, key) => {
            let value = params[key];
            try {
                if (value != null) {
                    const type = this.rawResource?.typeMap?.get(key);
                    if (type instanceof GraphQLScalarType) {
                        value = type.serialize(value);
                    }
                }
                coerced[key] = value;
                return coerced;
            } catch (thrown) {
                const error = thrown as Error;
                if (value === "" && !this.propertyMap.get(key)?.isRequired()) {
                    coerced[key] = null;
                    return coerced;
                }
                throw new ValidationError({
                    [key]: {
                        type: "conversion",
                        message: error.message,
                    },
                });
            }
        }, {} as ParamsType);
        return converted;
    }

    private validateParams(params: ParamsType) {
        const errors: PropertyErrors = {};

        const editProperties = this._decorated?.options?.editProperties ?? [];

        for (const key of this.properties().map((p) => p.path())) {
            const property = this._decorated?.getPropertyByKey(key);
            const value = params[key];

            // Skip properties that are not being edited
            if (
                editProperties.length &&
                !editProperties.includes(property?.property.path() ?? "")
            ) {
                continue;
            }

            // Skip self ID properties
            if (property?.isId() && property?.type() !== "reference") {
                continue;
            }

            const required =
                property?.options.isRequired ?? property?.isRequired();
            if (required) {
                if (value === "" || value === null || value === undefined) {
                    errors[key] = {
                        type: "required",
                        message: "Required field",
                    };
                }
            }
        }

        if (Object.keys(errors).length) {
            throw new ValidationError(errors);
        }
    }

    async create(params: ParamsType): Promise<ParamsType> {
        try {
            const inflated = inflateParams(this.convertParams(params));
            this.validateParams(inflated);
            const mapping = this.rawResource.create?.(inflated);
            if (!mapping) {
                throw new ForbiddenError("Resource is not editable");
            }
            return await this.executeMapping(mapping);
        } catch (error) {
            this.connection.reportAndThrow(error as Error);
        }
    }

    async update(id: string, params: ParamsType): Promise<ParamsType> {
        try {
            const inflated = inflateParams(this.convertParams(params));
            this.validateParams(inflated);
            const mapping = this.rawResource.update?.(id, inflated);
            if (!mapping) {
                throw new ForbiddenError("Resource is not editable");
            }
            return await this.executeMapping(mapping);
        } catch (error) {
            this.connection.reportAndThrow(error as Error);
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
            this.connection.reportAndThrow(error as Error);
        }
    }

    static isAdapterFor(resource: GraphQLResource): boolean {
        const internalResource = resource as InternalGraphQLResource;
        return internalResource.tag == "GraphQLResource";
    }

    private async executeMapping<T = Record<string, unknown>>(
        mapping: GraphQLQueryMapping<T>
    ): Promise<T> {
        const queryString =
            typeof mapping.query === "string"
                ? mapping.query
                : mapping.query.loc?.source.body;
        if (!queryString) {
            this.connection.reportAndThrow(
                new Error("Unexpected parsed query without body")
            );
        }
        const result = await this.connection.request(
            queryString,
            mapping.variables
        );
        const parsed = mapping.parseResult(result);
        if (!this.rawResource.makeSubproperties) {
            if (parsed instanceof Array) {
                return parsed.map((p) => deflateParams(p)) as unknown as T;
            } else {
                return deflateParams(parsed);
            }
        }
        return parsed;
    }

    private mapFilter(filter: Filter): FieldFilter[] {
        return filter.reduce<FieldFilter[]>((mapped, element) => {
            const from =
                typeof element.value == "string"
                    ? element.value
                    : element.value.from;
            const to =
                typeof element.value == "string" ? from : element.value.to;
            const matchOperation: FilterOperation =
                element.property.type() === "string" ? "MATCH" : "EQ";

            let graphQLType = this.rawResource.typeMap?.get(element.path);
            if (graphQLType instanceof GraphQLObjectType) {
                graphQLType = GraphQLID;
            }

            if (!graphQLType || !isInputType(graphQLType)) {
                this.connection.reportAndThrow(
                    new Error(
                        `Cannot get valid GraphQL type from ${this.rawResource.id}:${element.path}`
                    )
                );
            }

            const coercedFrom = convertValue(from, graphQLType);
            const coercedTo = convertValue(to, graphQLType);

            if (from === to) {
                mapped.push({
                    field: element.property.path(),
                    is: matchOperation,
                    to: coercedFrom,
                });
            } else {
                if (from !== undefined && from != "") {
                    mapped.push({
                        field: element.property.path(),
                        is: "GTE",
                        to: coercedFrom,
                    });
                }
                if (to !== undefined && to != "") {
                    mapped.push({
                        field: element.property.path(),
                        is: "LTE",
                        to: coercedTo,
                    });
                }
            }
            return mapped;
        }, []);
    }
}

function inflateParams(
    params: Record<string, unknown>
): Record<string, unknown> {
    const record: Record<string, unknown> = {};

    for (const path of Object.keys(params)) {
        const steps = path.split(".");
        let object = record;
        let index = -1;
        while (steps.length > 1) {
            const step = steps.shift();
            let nextObject = {};
            if (step === undefined) {
                break;
            }
            index = parseInt(steps[0]);
            if (!isNaN(index)) {
                nextObject = [];
            }
            object[step] = object[step] || nextObject;
            object = object[step] as typeof object;
        }

        if (object instanceof Array) {
            object.length = index + 1;
            object[index] = params[path];
        } else {
            object[steps[0]] = params[path];
        }
    }
    
    return record;
}

function deflateParams<T>(params: T, IDField = "ID"): T {
    if (typeof params !== "object" || params == null) {
        return params;
    }

    const typed = params as Record<string, unknown>;
    const record: Record<string, unknown> = {};

    for (const key of Object.keys(typed)) {
        let param = typed[key];
        if (typeof param === "object" && param !== null) {
            const deflated = deflateParams<Record<string, unknown>>(
                param as Record<string, unknown>
            );
            const deflatedKeys = Object.keys(deflated);
            if (deflatedKeys.length === 1 && IDField in deflated) {
                // Reference hack!
                param = Object.values(deflated)[0];
                record[key] = param;
            } else {
                for (const subKey of deflatedKeys) {
                    record[`${key}.${subKey}`] = deflated[subKey];
                }
            }
        } else {
            record[key] = param;
        }
    }

    return record as T;
}

function deflateReference(ref: unknown): string {
    if (typeof ref === "object" && ref !== null) {
        const fields = Object.values(ref);
        if (fields.length === 1) {
            return fields[0];
        }
    }
    return `${ref}`;
}

function convertValue(value: unknown, type: GraphQLType): unknown {
    if (type instanceof GraphQLScalarType) {
        return type.serialize(value);
    }
    return value;
}

export const _testing = {
    inflateParams,
    deflateParams,
};
