import { DocumentNode } from "graphql";
import { GraphQLResource, FieldFilter, GraphQLConnection } from "../index.js";
import {
    ResourceWithOptions,
    ResourceOptions,
    LocaleTranslations,
    LocaleTranslationsBlock,
    FeatureType,
} from "adminjs";
import { FindOptions } from "../GraphQLResource.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Entity = Record<string, any>;

/**
 * A descriptor for the different pieces that make a resource,
 * passed to `buildResource` to create a GraphQLResource instance.
 */
export interface BuildResourcePieces {
    /**
     * A GQL fragment, describing the field structure that will be exposed
     * to AdminBro as the representation of the resource.
     *
     * Example:
     * ```gql
     *  {
     *      ID
     *      name
     *  }
     * ```
     */
    fragment: string | DocumentNode;

    /**
     * The GraphQL type name of the resource.
     */
    type: string;

    /**
     * The GraphQL input type for the resource.
     * Defaults to `type.toLowerCase() + "Input"`.
     */
    inputType?: string;

    /**
     * Maps from adminjs entity field names to corresponding GraphQL field names
     * for count and find filtering, create and update.
     *
     * By default, the adminjs object is passed as is without any renaming of fields.
     */
    inputFieldMap?: Record<string, string>;

    /**
     * Extends the default mapping from adminjs entity to the corresponding
     * GraphQL input object for create and update mutations.
     *
     * Note that this extends the default mapping, which might have used the
     * specified `inputFieldMap`. Also, the fields returned are added to the
     * original entity object. Existing fields are replaced.
     * 
     * To remove a field, set the value to `undefined`.
     * 
     * @param input An AdminBro entity object
     * @returns A subset of fields to replace or add to the object
     */
    mapInputValue?(input: Entity): Entity;

    /**
     * Singular name of the type. Used to as the single object getter
     * query name. Defaults to the type name with an initial small letter.
     */
    singular?: string;

    /**
     * Plural name of the type. Defaults to the type name with added 's'.
     */
    plural?: string;

    /**
     * Name of the GraphQL API ID field, 'ID' by default.
     */
    ID?: string;

    queries?: {
        /**
         * Name of the GraphQL 'count' query, `singular + "Count"` by default.
         */
        count?: string;

        /**
         * Name of the GraphQL 'find' query, `plural` by default.
         */
        find?: string;

        /**
         * Name of the GraphQL 'get' query, `singular` by default.
         */
        get?: string;
    };

    /**
     * Names of the GraphQL mutations. By default the
     * operation plus `singular` with initial capital letter.
     */
    mutations?: {
        create?: string;
        update?: string;
        delete?: string;
    };

    /**
     * Query level directives that will be applied to
     * all queries for this resource.
     */
    queryDirectives?: string;
}

/**
 * Builds a `GraphQLResource` from pieces.
 */
export function buildResource(pieces: BuildResourcePieces): GraphQLResource {
    const IDField = pieces.ID || "ID";
    const singular =
        pieces.singular || pieces.type[0].toLowerCase() + pieces.type.slice(1);
    const plural = pieces.plural || singular + "s";
    const fragmentString = (
        typeof pieces.fragment === "string"
            ? pieces.fragment
            : pieces.fragment.loc?.source.body
    )?.trim();
    const queryDirectives = pieces.queryDirectives ?? "";
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
            ...pieces.mapInputValue?.(v),
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
            query($filter: [FilterInput!]) ${queryDirectives} {
                count: ${
                    pieces.queries?.count || `${singular}Count`
                }(filter: $filter)
            }`,
            variables: {
                filter: filter.map((entry) => ({
                    ...entry,
                    field: pieces.inputFieldMap?.[entry.field] ?? entry.field,
                })),
            },
            parseResult(response: { count: number }) {
                return response.count;
            },
        }),

        find: (filter: FieldFilter[], options: FindOptions) => ({
            query: `
            query($filter: [FilterInput!], $sorting: SortingInput, $offset: Int, $limit: Int) ${queryDirectives} {
                q: ${
                    pieces.queries?.find || plural
                }(filter: $filter, sorting: $sorting, offset: $offset, limit:$limit) {
                    ...fields
                }
            }
            fragment fields on ${pieces.type} ${fragmentString} `,
            variables: (() => {
                const sortField = options.sort?.sortBy;
                const sortOrder = options.sort?.direction?.toUpperCase();
                const sorting = sortField
                    ? {
                          sorting: {
                              by: sortField,
                              order: sortOrder ?? "ASC",
                          },
                      }
                    : undefined;

                const offset = options.offset
                    ? {
                          offset: options.offset,
                      }
                    : undefined;

                const limit = options.limit
                    ? {
                          limit: options.limit,
                      }
                    : undefined;

                return {
                    filter: filter.map((entry) => ({
                        ...entry,
                        field:
                            pieces.inputFieldMap?.[entry.field] ?? entry.field,
                    })),
                    ...sorting,
                    ...offset,
                    ...limit,
                };
            })(),
            parseResult(response: { q: Entity[] }) {
                return response.q;
            },
        }),

        findOne: (ID: string | number) => ({
            query: `
            query($ID: ID!) ${queryDirectives} {
                q: ${pieces.queries?.get || singular} (${IDField}: $ID) {
                    ...fields
                }
            }
            fragment fields on ${pieces.type} ${fragmentString} `,
            variables: {
                ID,
            },
            parseResult(response: { q: Entity }) {
                return response.q;
            },
        }),

        create: (entity: Entity) => ({
            query: `
            mutation($input: ${inputType}!) ${queryDirectives} {
                m: ${createMutation} (input: $input) {
                    ...fields
                }
            }
            fragment fields on ${pieces.type} ${fragmentString} `,
            variables: {
                input: mapInputValue(entity),
            },
            parseResult(response: { m: Entity }) {
                return response.m;
            },
        }),

        update: (ID: string | number, entity: Entity) => ({
            query: `
            mutation($ID: ID!, $update: ${inputType}!) ${queryDirectives} {
                m: ${updateMutation} (${IDField}: $ID, update: $update) {
                    ...fields
                }
            }
            fragment fields on ${pieces.type} ${fragmentString} `,
            variables: {
                ID,
                update: bodyOf(mapInputValue(entity)),
            },
            parseResult(response: { m: Entity }) {
                return response.m;
            },
        }),

        delete: (ID: string | number) => ({
            query: `
            mutation($ID: ID!) ${queryDirectives} {
                m: ${deleteMutation} (${IDField}: $ID)
            }
            `,
            variables: {
                ID,
            },
            parseResult() {
                //
            },
        }),
    };
}

export interface ConfiguredResource {
    resource: GraphQLResource;
    configuration(connection: GraphQLConnection): ResourceWithOptions;
    translations?: LocaleTranslations["resources"];
}

/**
 * Resource pieces and corresponding AdminBro configuration
 * options to create a configured resource.
 */
export interface ConfigureResourceOptions {
    /**
     * The GraphQL type name of the resource.
     */
    type: string;

    /**
     * The GraphQL side of the resource configuration
     */
    pieces: Omit<BuildResourcePieces, "type">;

    /**
     * Overrides for the `GraphQLResource` object
     * created from the pieces above.
     */
    extras?: Partial<GraphQLResource>;

    /**
     * AdminBro resource options
     */
    options?: ResourceOptions;

    /**
     * AdminBro resource features
     */
    features?: FeatureType[];

    /**
     * AdminBro resource translations
     */
    resourceTranslations?: Partial<LocaleTranslationsBlock>;
}

/**
 * Extends `buildResource` with configuration options to
 * build a fully configured resource.
 *
 * This keeps GraphQL resource definition and AdminBro
 * configuration of the resource in one place.
 */
export function configureResource(
    options: ConfigureResourceOptions
): ConfiguredResource {
    const resource = {
        ...buildResource({
            ...options.pieces,
            type: options.type,
        }),
        ...options.extras,
    };

    const configuration = (
        connection: GraphQLConnection
    ): ResourceWithOptions => ({
        resource: connection.r[options.type],
        options: options.options ?? {},
        features: options.features,
    });

    const translations = options.resourceTranslations
        ? {
              [options.type]: options.resourceTranslations,
          }
        : undefined;

    return {
        resource,
        configuration,
        // @ts-ignore
        translations,
    };
}

function bodyOf(entity: Entity): Entity {
    const body = {
        ...entity,
    };
    delete body.ID;
    return body;
}
