# adminjs-graphql

This is an [adminjs](https://github.com/SoftwareBrothers/adminjs) adapter integrating GraphQL endpoints into adminjs.

Installation: `npm add adminjs-graphql`.

This adapter lets you define AdminJS resources in terms of GraphQL queries and mutations.

Also, the adapter exposes the GraphQL connection, making it possible to do direct calls to the remote API from actions, et.c.

## Registering and defining resources

Register the adapter using the standard `AdminJS.registerAdapter` method, then map each resource to GraphQL queries and mutations. Don't forget to initialize the connection before passing it to the `AdminJS` constructor.

During initialization, the adapter will pull schema information from the GraphQL endpoint, and populate the resource properties.

You can either pass the whole `GraphQLConnection` as a database to adminjs, or pass each resource individually using the connection's `resources` map.

See the example below for basic usage using the Koa AdminJS router.

This convoluted example is a lucky example, since the GraphQL endpoint happens to match the filtering and pagination parameters passed by the adapter. In real situations, there will be more going on in the mapping implementation.

The only required operations to implement are `count`, `find` and `findOne`. It's assumed that `find` and `findOne` return objects of the same shape.

You might want to build your own utility toolset to simplify the adaption of you GraphQL API. 
See [src/builder](src/builder) for an example of such a toolset.

## Using the GraphQL connection from an action

With `context` being an ActionContext:

```typescript
const graphQLResource = context.resource as GraphQLResourceAdapter;
const connection = graphQLResource.rawResource.connection;

const mutation = `
mutation ($answer: Int!) {
    setAnswer(answer: $answer)
}`;

const response = await connection.request(mutation, {
    answer: 42,
});
```

## Complete resource example

```typescript
import AdminJS, { BaseRecord } from "adminjs";
import Koa from "koa";
import { buildRouter } from "@adminjs/koa";
import gql from "graphql-tag";

import {
    FieldFilter,
    FindOptions,
    GraphQLAdapter,
    GraphQLConnection,
} from "adminjs-graphql";

AdminJS.registerAdapter(GraphQLAdapter);

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
        app.use(router.routes());
        app.listen(3001);
    })
    .catch((err: Error) => {
        console.log(err.message);
    });

```
