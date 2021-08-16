import AdminBro from "admin-bro";
import Koa from "koa";
import { buildRouter } from "@admin-bro/koa";
import gql from "graphql-tag";

import {
    configureResource,
    GraphQLAdapter,
    GraphQLConnection,
} from "admin-bro-graphql";

AdminBro.registerAdapter(GraphQLAdapter);

type Entity = Record<string, Record<string, unknown> | Array<unknown>>;

const thingResource = configureResource({
    type: "Thing",
    pieces: {
        fragment: gql`
            {
                ID
                name
                another {
                    ID
                }
            }
        `,
        mapInputValue: (input: Entity) => ({
            name: input.name,
            anotherIDs: input.another,
        }),
    },
    extras: {
        sortableFields: ["name"],
    },
    options: {
        // editProperties: ["name"],
        listProperties: ["ID", "name"],
    },
});

const otherResource = configureResource({
    type: "Other",
    pieces: {
        fragment: gql`
            {
                ID
                name
            }
        `,
    },
});

const connection = new GraphQLConnection(
    [thingResource.resource, otherResource.resource],
    { name: "My stuff", url: "http://localhost:3000/graphql" },
    (e) => console.log(e)
);

connection
    .init()
    .then(() => {
        const app = new Koa();

        const admin = new AdminBro({
            resources: [
                thingResource.configuration(connection),
                otherResource.configuration(connection),
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
