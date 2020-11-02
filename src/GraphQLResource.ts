import { DocumentNode, GraphQLNamedType, isInputType, coerceValue, GraphQLScalarType, GraphQLObjectType, GraphQLID } from "graphql";
import { PropertyType, ParamsType, BaseResource, BaseRecord, Filter, ForbiddenError } from "admin-bro";
import { GraphQLConnection } from ".";
import { GraphQLPropertyAdapter } from "./GraphQLProperty";

export interface GraphQLQueryMapping<T> {
    query: string | DocumentNode;
    variables?: Record<string, unknown>;
    parseResult(result: Record<string, unknown>): T;
}

export interface FindOptions {
    limit?: number;
    offset?: number;
    sort?: {
        sortBy?: string;
        direction?: "asc" | "desc";
    }
}

export interface GraphQLResource {
    id: string;

    sortableFields?: string[];
    // ??? Remove?
    fieldTypes?: { [field: string]: PropertyType };
    // ??? Remove?
    referenceFields?: { [field: string]: string };
    makeSubproperties?: boolean;

    // queries:
    count: (filter: FieldFilter[]) => GraphQLQueryMapping<number>;
    find: (filter: FieldFilter[], options: FindOptions) => GraphQLQueryMapping<ParamsType[]>;
    findOne: (id: string | number) => GraphQLQueryMapping<ParamsType | null>;

    // mutations:
    create?: (record: ParamsType) => GraphQLQueryMapping<ParamsType>;
    update?: (id: string | number, record: ParamsType) => GraphQLQueryMapping<ParamsType>;
    delete?: (id: string | number) => GraphQLQueryMapping<void>;
}

export type FilterOperation = "GTE" | "LTE" | "EQ" | "MATCH";

export interface FieldFilter {
    field: string;
    is: FilterOperation;
    than?: string;
    to?: string;
}

export type InternalGraphQLResource = GraphQLResource & {
    tag: "GraphQLResource";
    connection?: GraphQLConnection;
    properties?: GraphQLPropertyAdapter[];
    typeMap?: Map<string, GraphQLNamedType>;
}

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
            const mapping = this.rawResource.findOne(deflateReference(id));
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

    coerceParams(params: ParamsType): ParamsType {
        return Object.keys(params).reduce((coerced, key) => {
            let value = params[key];
            const type = this.rawResource?.typeMap?.get(key);
            if (type instanceof GraphQLScalarType) {
                value = type.serialize(value);
            }
            coerced[key] = value;
            return coerced;
        }, {} as ParamsType);
    }

    async create(params: ParamsType): Promise<ParamsType> {
        try {
            const inflated = inflateParams(this.coerceParams(params));
            const mapping = this.rawResource.create?.(inflated);
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
            const inflated = inflateParams(this.coerceParams(params));
            const mapping = this.rawResource.update?.(id, inflated);
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

            const from = typeof element.value == "string" ? element.value : element.value.from;
            const to = typeof element.value == "string" ? from : element.value.to;
            const matchOperation: FilterOperation = typeof element.value == "string" ? "MATCH" : "EQ";

            let graphQLType = this.rawResource.typeMap?.get(element.path);
            if (graphQLType instanceof GraphQLObjectType) {
                graphQLType = GraphQLID;
            }

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

            if (from === to) {
                mapped.push({
                    field: element.property.path(),
                    is: matchOperation,
                    to: coercedFrom.value,
                });
            } else {
                mapped.push(
                    {
                        field: element.property.path(),
                        is: "GTE",
                        to: coercedFrom.value,
                    },
                    {
                        field: element.property.path(),
                        is: "LTE",
                        to: coercedTo.value,
                    }
                );
            }
            return mapped;
        }, []);
    }

}

function inflateParams(params: Record<string, unknown>): Record<string, unknown> {
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
            if (steps.length === 1) {
                index = parseInt(steps[0]);
                if (!isNaN(index)) {
                    nextObject = [];
                }
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
            const deflated = deflateParams<Record<string, unknown>>(param as Record<string, unknown>);
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

export const _testing = {
    inflateParams,
    deflateParams,
};
