import { _testing } from "../src/GraphQLResource";
const { deflateParams, inflateParams } = _testing;

describe("Resource parameter deflation", () => {
    it("Deflates string OK", () => {
        const input = "a string";
        const deflated = deflateParams(input);
        expect(deflated).toEqual(input);
    });

    it("Deflates undefined OK", () => {
        const input = undefined;
        const deflated = deflateParams(input);
        expect(deflated).toEqual(input);
    });

    it("Deflates one level object OK", () => {
        const input = {
            a: 1,
            b: "bee"
        };
        const deflated = deflateParams(input);
        expect(deflated).toEqual(input);
    });

    it("Deflates deep object OK", () => {
        const input = {
            a: 1,
            b: "bee",
            c: {
                d: {
                    e: "eee"
                }
            }
        };
        const expected = {
            a: 1,
            b: "bee",
            "c.d.e": "eee"
        };
        const deflated = deflateParams(input);
        expect(deflated).toEqual(expected);
    });
});

describe("Resource parameter inflation", () => {
    it("Inflates one level object OK", () => {
        const input = {
            a: 1,
            b: "bee"
        };

        const inflated = inflateParams(input);
        expect(inflated).toEqual(input);
    });

    it("Inflates deep object OK", () => {
        const input = {
            a: 1,
            b: "bee",
            "c.d.e": "eee",
        };

        const expected = {
            a: 1,
            b: "bee",
            c: {
                d: {
                    e: "eee"
                }
            }
        };

        const inflated = inflateParams(input);
        expect(inflated).toEqual(expected);
    });

    it("Inflates nested array OK", () => {
        const input = {
            "array.0": "zero",
            "array.3": "three",
        };

        const expected = {
            array: [
                "zero",
                undefined,
                undefined,
                "three",
            ]
        };

        const inflated = inflateParams(input);
        expect(inflated).toEqual(expected);
    });
});
