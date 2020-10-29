import AdminBro from "admin-bro";
import Koa from "koa";
import { buildRouter } from "@admin-bro/koa";
import gql from "graphql-tag";

import { configureResource, GraphQLAdapter, GraphQLConnection } from "admin-bro-graphql";

AdminBro.registerAdapter(GraphQLAdapter);

const thingResource = configureResource("Thing",
    {
        fragment: gql`
        {
            ID
            name
        }
    `,
    },
    {
        sortableFields: ["name"]
    },
    {
        editProperties: ["name"],
        listProperties: ["ID", "name"]
    }
);

const connection = new GraphQLConnection(
    [
        thingResource.resource
    ],
    { name: "My stuff", url: "http://localhost:3000/graphql" }
);

connection.init().then(() => {
    const app = new Koa();

    const admin = new AdminBro({
        resources: [
            thingResource.configuration(connection)
        ],
        rootPath: "/admin",
    });

    const router = buildRouter(admin, app);
    app.use(router.routes());
    app.listen(3001);
}).catch((err: Error) => {
    console.log(err.message);
});
