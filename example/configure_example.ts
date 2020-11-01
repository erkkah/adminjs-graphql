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
            another {
                ID
            }
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

const otherResource = configureResource("Other",
    {
        fragment: gql`
        {
            ID
            name
        }
    `
    },
);

const connection = new GraphQLConnection(
    [
        thingResource.resource,
        otherResource.resource
    ],
    { name: "My stuff", url: "http://localhost:3000/graphql" },
    (e) => console.log(e)
);

connection.init().then(() => {
    const app = new Koa();

    const admin = new AdminBro({
        resources: [
            thingResource.configuration(connection),
            otherResource.configuration(connection)
        ],
        rootPath: "/admin",
    });

    const router = buildRouter(admin, app);
    app.use(router.routes());
    app.listen(3001);
}).catch((err: Error) => {
    console.log(err.message);
});
