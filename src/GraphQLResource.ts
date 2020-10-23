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
