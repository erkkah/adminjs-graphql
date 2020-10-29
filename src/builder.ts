import { DocumentNode } from "graphql";
import { GraphQLResource, FieldFilter, GraphQLConnection } from ".";
import { ResourceWithOptions, ResourceOptions, LocaleTranslations, LocaleTranslationsBlock } from "admin-bro";

type Entity = Record<string, unknown>;

export interface BuildResourcePieces {
    fragment: string | DocumentNode;
    type: string;
    inputType?: string;
    mapInputValue?(input: Entity): Entity,
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
    const identity = (v: Entity) => v;
    const mapInputValue = pieces.mapInputValue ?? identity;

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
                filter
            },
            parseResult(response: { q: unknown[] }) {
                return response.q.length;
            }
        }),

        find: (filter: FieldFilter[]) => ({
            query: `
            query($filter: [FilterInput!]) {
                q: ${pieces.queries?.find || plural}(filter: $filter) {
                    ...fields
                }
            }
            fragment fields on ${pieces.type} ${fragmentString} `,
            variables: {
                filter
            },
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

export function configureResource(
    type: string,
    pieces: Omit<BuildResourcePieces, "type">,
    extras?: Partial<GraphQLResource>,
    options: ResourceOptions = {},
    resourceTranslations?: Partial<LocaleTranslationsBlock>,
): ConfiguredResource {
    const resource = {
        ...buildResource({
            ...pieces,
            type,
        }),
        ...extras
    };

    const configuration = (connection: GraphQLConnection): ResourceWithOptions => ({
        resource: connection.r[type],
        options
    });

    const translations = resourceTranslations
        ? {
            [type]: resourceTranslations
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
