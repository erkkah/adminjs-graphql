import { DocumentNode } from "graphql";
import { GraphQLResource, FieldFilter, GraphQLConnection } from ".";
import { ResourceWithOptions, ResourceOptions, LocaleTranslations, LocaleTranslationsBlock, FeatureType } from "admin-bro";
import { FindOptions } from "./GraphQLResource";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Entity = Record<string, any>;

export interface BuildResourcePieces {
    fragment: string | DocumentNode;
    type: string;
    inputType?: string;
    mapInputValue?(input: Entity): Entity,
    inputFieldMap?: Record<string, string>,
    singular?: string;
    plural?: string;
    ID?: string;
    queries?: {
        list?: string;
        find?: string;
        get?: string;
    },
    mutations?: {
        create?: string;
        update?: string;
        delete?: string;
    },
}

export function buildResource(pieces: BuildResourcePieces): GraphQLResource {
    const IDField = pieces.ID || "ID";
    const singular = pieces.singular || pieces.type[0].toLowerCase() + pieces.type.slice(1);
    const plural = pieces.plural || singular + "s";
    const fragmentString = ((typeof pieces.fragment === "string")
        ? pieces.fragment
        : pieces.fragment.loc?.source.body)?.trim();
    const inputType = pieces.inputType || `${pieces.type}Input`;
    const upperTail = singular[0].toUpperCase() + singular.slice(1);
    const createMutation = pieces.mutations?.create || "create" + upperTail;
    const updateMutation = pieces.mutations?.update || "update" + upperTail;
    const deleteMutation = pieces.mutations?.delete || "delete" + upperTail;
    const mapInputValue = (v: Entity) => {
        return {
            ...Object.keys(v).reduce((value, key) => {
                value[pieces.inputFieldMap?.[key] ?? key] = v[key];
                return value;
            }, {} as Entity),
            ...pieces.mapInputValue?.(v)
        };
    };

    if (!fragmentString) {
        throw new Error("Unexpected empty fragment");
    }

    if (!fragmentString.startsWith("{") || !fragmentString.endsWith("}")) {
        throw new Error("Fragment must be specified within curly brackets");
    }

    return {
        id: pieces.type,
        count: (filter: FieldFilter[]) => ({
            query: `
            query($filter: [FilterInput!]) {
                q: ${pieces.queries?.list || plural}(filter: $filter) {
                    ${IDField}
                }
            }`,
            variables: {
                filter: filter.map((entry) => ({
                    ...entry,
                    field: pieces.inputFieldMap?.[entry.field] ?? entry.field
                })),
            },
            parseResult(response: { q: unknown[] }) {
                return response.q.length;
            }
        }),

        find: (filter: FieldFilter[], options: FindOptions) => ({
            query: `
            query($filter: [FilterInput!], $sorting: SortingInput, $offset: Int, $limit: Int) {
                q: ${pieces.queries?.find || plural}(filter: $filter, sorting: $sorting, offset: $offset, limit:$limit) {
                    ...fields
                }
            }
            fragment fields on ${pieces.type} ${fragmentString} `,
            variables: (() => {
                const sortField = options.sort?.sortBy;
                const sortOrder = options.sort?.direction?.toUpperCase();
                const sorting = sortField ? {
                    sorting: {
                        by: sortField,
                        order: sortOrder ?? "ASC",
                    }
                } : undefined;

                const offset = options.offset ? {
                    offset: options.offset
                } : undefined;

                const limit = options.limit ? {
                    limit: options.limit
                } : undefined;

                return {
                    filter: filter.map((entry) => ({
                        ...entry,
                        field: pieces.inputFieldMap?.[entry.field] ?? entry.field
                    })),
                    ...sorting,
                    ...offset,
                    ...limit,
                };
            })(),
            parseResult(response: { q: Entity[] }) {
                return response.q;
            }
        }),

        findOne: (ID: string | number) => ({
            query: `
            query($ID: ID!){
                q: ${pieces.queries?.get || singular} (${IDField}: $ID) {
                    ...fields
                }
            }
            fragment fields on ${pieces.type} ${fragmentString} `,
            variables: {
                ID
            },
            parseResult(response: { q: Entity }) {
                return response.q;
            }

        }),

        create: (entity: Entity) => ({
            query: `
            mutation($input: ${inputType}!) {
                m: ${createMutation} (input: $input) {
                    ...fields
                }
            }
            fragment fields on ${pieces.type} ${fragmentString} `,
            variables: {
                input: mapInputValue(entity)
            },
            parseResult(response: { m: Entity }) {
                return response.m;
            }
        }),

        update: (ID: string | number, entity: Entity) => ({
            query: `
            mutation($ID: ID!, $update: ${inputType}!) {
                m: ${updateMutation} (${IDField}: $ID, update: $update) {
                    ...fields
                }
            }
            fragment fields on ${pieces.type} ${fragmentString} `,
            variables: {
                ID,
                update: bodyOf(mapInputValue(entity))
            },
            parseResult(response: { m: Entity }) {
                return response.m;
            }
        }),

        delete: (ID: string | number) => ({
            query: `
            mutation($ID: ID!) {
                m: ${deleteMutation} (${IDField}: $ID)
            }
            `,
            variables: {
                ID
            },
            parseResult() {
                //
            }
        })
    };
}


export interface ConfiguredResource {
    resource: GraphQLResource;
    configuration(connection: GraphQLConnection): ResourceWithOptions;
    translations?: LocaleTranslations["resources"];
}

export interface ConfigureResourceOptions {
    type: string,
    pieces: Omit<BuildResourcePieces, "type">,
    extras?: Partial<GraphQLResource>,
    options?: ResourceOptions,
    features?: FeatureType[],
    resourceTranslations?: Partial<LocaleTranslationsBlock>,
}

export function configureResource(options: ConfigureResourceOptions): ConfiguredResource {
    const resource = {
        ...buildResource({
            ...options.pieces,
            type: options.type,
        }),
        ...options.extras
    };

    const configuration = (connection: GraphQLConnection): ResourceWithOptions => ({
        resource: connection.r[options.type],
        options: options.options ?? {},
        features: options.features
    });

    const translations = options.resourceTranslations
        ? {
            [options.type]: options.resourceTranslations
        }
        : undefined;

    return {
        resource,
        configuration,
        translations,
    };
}

function bodyOf(entity: Entity): Entity {
    const body = {
        ...entity
    };
    delete body.ID;
    return body;
}
