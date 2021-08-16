import AdminBro, { BaseRecord } from "admin-bro";
import Koa from "koa";
import { buildRouter } from "@admin-bro/koa";
import gql from "graphql-tag";

import {
    FieldFilter,
    FindOptions,
    GraphQLAdapter,
    GraphQLConnection,
} from "admin-bro-graphql";

AdminBro.registerAdapter(GraphQLAdapter);

const connection = new GraphQLConnection(
    [
        {
            id: "Thing",

            count: (filter: FieldFilter[]) => ({
                query: gql`
                    query ($filter: [FilterInput!]) {
                        thingCount(filter: $filter)
                    }
                `,
                variables: {
                    filter,
                },
                parseResult(result: Record<string, number>) {
                    return result.thingCount;
                },
            }),

            find: (filter: FieldFilter[], options: FindOptions) => ({
                query: gql`
                    query ($filter: [FilterInput!], $offset: Int, $limit: Int) {
                        things(
                            filter: $filter
                            offset: $offset
                            limit: $limit
                        ) {
                            ID
                            name
                        }
                    }
                `,
                variables: {
                    filter,
                    offset: options.offset,
                    limit: options.limit,
                },
                parseResult(
                    result: Record<string, BaseRecord[]>
                ): BaseRecord[] {
                    return result.things;
                },
            }),

            findOne: (ID: string | number) => ({
                query: gql`
                    query ($ID: ID!) {
                        thing(ID: $ID) {
                            ID
                            name
                        }
                    }
                `,
                variables: {
                    ID,
                },
                parseResult(result: Record<string, BaseRecord | null>) {
                    return result.thing;
                },
            }),
            sortableFields: ["name"],
        },
    ],
    { name: "My stuff", url: "http://localhost:3000/graphql" },
    (error: Error) => console.log(error)
);

connection
    .init()
    .then(() => {
        const app = new Koa();

        const admin = new AdminBro({
            resources: [
                {
                    resource: connection.r.Thing,
                    options: {
                        editProperties: ["name"],
                        listProperties: ["ID", "name"],
                    },
                },
            ],
            rootPath: "/admin",
        });

        const router = buildRouter(admin, app);
        app.use(router.routes()).use(async (context, next) => {
            if (context.path == "/") {
                context.redirect("/admin");
            }
            return next();
        });

        const server = app.listen(3001).on("listening", () => {
            console.log("Example running at:", server.address());
        });
    })
    .catch((err: Error) => {
        console.log(err.message);
    });
