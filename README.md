# admin-bro-graphql

This is an [admin-bro](https://github.com/SoftwareBrothers/admin-bro) adapter which integrates GraphQL endpoints into admin-bro.

Installation: `npm add admin-bro-graphql`.

## Usage

Register the adapter using the standard `AdminBro.registerAdapter` method, then map each resource to GraphQL queries and mutations. Don't forget to initialize the connection before passing it to the `AdminBro` constructor.

During initialization, the adapter will pull schema information from the GraphQL endpoint, and populate the resource properties.

You can either pass the whole `GraphQLConnection` as a database to admin-bro, or pass each resource individually using the connection's `resources` map.

The convoluted example below is a lucky example, since the GraphQL endpoint happens to match the filtering and pagination parameters passed by the adapter. In real situations, there will be more going on in the mapping implementation.

The only required operations to implement are `count`, `find` and `findOne`. It's assumed that `find` and `findOne` return objects of the same shape.

```typescript
import AdminBro, { BaseRecord } from "admin-bro";
import { FieldFilter, FindOptions, GraphQLAdapter, GraphQLConnection } from "admin-bro-graphql";
AdminBro.registerAdapter(GraphQLAdapter);

const connection = new GraphQLConnection({ name: "Stuff", url: "http://localhost:3000/graphql" }, [
    {
        id: "things",

        count: (filter: FieldFilter[]) => ({
            query: `{
                thingsCount(matching: $filter)
            }`,
            variables: {
                filter
            },
            parseResult(result: Record<string, number>) {
                return result.thingsCount;
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
            parseResult(result: Record<string, BaseRecord[]>): BaseRecord[] {
                return result.things;
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
            parseResult(result: Record<string, BaseRecord | null>) {
                return result.thingById;
            }
        })
    }
]);

connection.init().then(() => {
    new AdminBro({
        // databases: [connection],
        resources: [{resource: connection.r.things}],
        rootPath: "/admin",
    });
}).catch((err: Error) => {
    console.log(err.message);
});

```
