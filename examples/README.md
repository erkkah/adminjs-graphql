# admin-bro-graphql examples

Some basic examples for using the GraphQL adapter.

### `connection_example.ts`

Example showing the core functionality of the adapter, which can be used directly with any exising GraphQL API.

### `build_example.ts`

Example using the `buildResource` utility function from the `builder` directory.

### `configure_example.ts`

Example using the `configureResource` utility function from the `builder` directory.

## Running the examples

The examples includes a simple GraphQL API server, and three different example uses of the adapter.

Install dependencies:

```shell
npm install
```

Start the server:

```shell
$ npm run server
```

In a separate shell, you can now start any of the examples:

```shell
$ npm run connection_example
```

The API server runs on port 3000, and the examples on port 3001.
