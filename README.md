# admin-bro-graphql

This is an [admin-bro](https://github.com/SoftwareBrothers/admin-bro) adapter which integrates GraphQL endpoints into admin-bro.

Installation: `npm add admin-bro-graphql`.

## Usage

First register using the standard `AdminBro.registerAdapter` method, then map each resource to GraphQL queries and mutations. Don't forget to initialize the connection before passing it to the `AdminBro` constructor.

You can either pass the whole `GraphQLConnection` as a database to admin-bro, or pass each resource individually using the connection's `resources` map.

The convoluted example below is a happy example, since the GraphQL endpoint happens to match the filtering and pagination parameters passed by the adapter. In real situations, there will be more going on in the mapping.

The only required operations to implement are `count`, `find` and `findOne`.

```typescript
import { FieldFilter, FindOptions, GraphQLAdapter, GraphQLConnection } from "admin-bro-graphql";
AdminBro.registerAdapter(GraphQLAdapter);

const connection = new GraphQLConnection({ name: "Stuff", url: "http://localhost:3000/graphql" }, {
    things: {
        id: "things",

        count: (filter: FieldFilter[]) => ({
            query: `{
                thingsCount(matching: $filter)
            }`,
            variables: {
                filter
            },
            parseResult(response: any) {
                return response.thingsCount;
            }
        }),

        find: (filter: FieldFilter[], options: FindOptions) => ({
            query: `{
                things(matching: $filter, offset: $offset, limit: $limit) {
                    id
                    name
                    size
                }
            }`,
            variables: {
                filter,
                offset: options.offset,
                limit: options.limit,
            },
            parseResult(response: any) {
                return response.things;
            }
        }),

        findOne: (id: string | number) => ({
            query: `{
                thingById(id: $id){
                    id
                    name
                    size
                }
            }`,
            variables: {
                id
            },
            parseResult(response: any) {
                return response.thingById;
            }
        })
    }
});

await connection.init();

const adminBro = new AdminBro({
    // databases: [connection],
    resources: [resource: connection.resources.things],
    rootPath: "/admin",
});


```
