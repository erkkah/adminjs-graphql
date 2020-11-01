import { DocumentNode, GraphQLNamedType, isInputType, coerceValue } from "graphql";
import { PropertyType, ParamsType, BaseResource, BaseRecord, BaseProperty, Filter, ForbiddenError } from "admin-bro";
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
    fieldTypes?: { [field: string]: PropertyType };
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

export type FilterOperation = "GTE" | "LTE" | "EQ";

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

    async populate(records: Array<BaseRecord>, property: BaseProperty): Promise<Array<BaseRecord>> {
        const propertyName = property.name();

        const recordIDs = records
            .map((record) => ({
                rec: record,
                key: record.param(propertyName),
            }))
            .map((record) => {
                if (typeof record.key === "object") {
                    const fields = Object.values(record.key);
                    if (fields.length === 1) {
                        record.key = fields[0];
                    }
                }
                return record;
            });

        const keys = recordIDs.map((rec) => rec.key);
        const subrecords = await this.findMany(keys);
        const recordMap = new Map(subrecords.map((record) => [record.id(), record]));

        return recordIDs.map((rec) => {
            const key = rec.key;
            const subrecord = recordMap.get(key);
            if (subrecord) {
                rec.rec.populated[propertyName] = subrecord;
            }
            return rec.rec;
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

            if (from === to) {
                mapped.push({
                    field: element.property.path(),
                    is: "EQ",
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

function deflateParams<T>(params: T): T {
    if (typeof params !== "object" || params == null) {
        return params;
    }

    const typed = params as Record<string, unknown>;
    const record: Record<string, unknown> = {};

    for (const key of Object.keys(typed)) {
        const param = typed[key];
        if (typeof param === "object" && param !== null) {
            const deflated = deflateParams<Record<string, unknown>>(param as Record<string, unknown>);
            for (const subKey of Object.keys(deflated)) {
                record[`${key}.${subKey}`] = deflated[subKey];
            }
        } else {
            record[key] = param;
        }
    }

    return record as T;
}

export const _testing = {
    inflateParams,
    deflateParams,
};
