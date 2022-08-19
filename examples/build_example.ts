import AdminJS from "adminjs";
import Koa from "koa";
import { buildRouter } from "@adminjs/koa";
import gql from "graphql-tag";

import {
    buildResource,
    GraphQLAdapter,
    GraphQLConnection,
} from "adminjs-graphql";

AdminJS.registerAdapter(GraphQLAdapter);

const connection = new GraphQLConnection(
    [
        {
            ...buildResource({
                type: "Thing",
                fragment: gql`
                    {
                        ID
                        name
                    }
                `,
            }),
            sortableFields: ["name"],
        },
    ],
    { name: "My stuff", url: "http://localhost:3000/graphql" }
);

connection
    .init()
    .then(() => {
        const app = new Koa();

        const admin = new AdminJS({
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
