import AdminBro from "admin-bro";
import Koa from "koa";
import { buildRouter } from "@admin-bro/koa";
import gql from "graphql-tag";

import { buildResource, GraphQLAdapter, GraphQLConnection } from "admin-bro-graphql";

AdminBro.registerAdapter(GraphQLAdapter);

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
            sortableFields: ["name"]
        }
    ],
    { name: "My stuff", url: "http://localhost:3000/graphql" }
);

connection.init().then(() => {
    const app = new Koa();

    const admin = new AdminBro({
        resources: [{
            resource: connection.r.Thing,
            options: {
                editProperties: ["name"],
                listProperties: ["ID", "name"]
            }
        }],
        rootPath: "/admin",
    });

    const router = buildRouter(admin, app);
    app.use(router.routes());
    app.listen(3001);
}).catch((err: Error) => {
    console.log(err.message);
});
