import AdminBro, { BaseRecord } from "admin-bro";
import { FieldFilter, FindOptions, GraphQLAdapter, GraphQLConnection } from "../src";
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
