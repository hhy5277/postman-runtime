var _ = require('lodash'),
    aws4 = require('aws4'),
    crypto = require('crypto'),
    querystring = require('querystring'),
    RequestBody = require('postman-collection').RequestBody,
    urlencodedBodyBuilder = require('../requester/core-body-builder').urlencoded,

    BODY_HASH_HEADER = 'X-Amz-Content-Sha256',

    /**
     * Encodes characters not encoded by querystring.stringify() according to RFC3986.
     * REFER: https://github.com/postmanlabs/postman-request/blob/master/lib/querystring.js#L42
     *
     * @param {String} str Partially encoded string by querystring.stringify()
     * @returns {String} Fully encoded string
     */
    rfc3986 = function (str) {
        return str.replace(/[!'()*]/g, function (c) {
            return '%' + c.charCodeAt(0).toString(16).toUpperCase();
        });
    },

    /**
     * Calculates body hash with given algorithm and digestEncoding.
     *
     * @todo This function can also be used in Digest auth so that it works correctly for urlencoded and file body types
     *
     * @param {RequestBody} body
     * @param {String} algorithm
     * @param {String} digestEncoding
     * @param {Function} callback
     */
    computeBodyHash = function (body, algorithm, digestEncoding, callback) {
        if (!(body && algorithm && digestEncoding)) { return callback(); }

        var hash = crypto.createHash(algorithm),
            originalReadStream,
            urlencodedBody;

        if (body.mode === RequestBody.MODES.raw) {
            hash.update(body.toString());

            return callback(hash.digest(digestEncoding));
        }

        if (body.mode === RequestBody.MODES.urlencoded) {
            urlencodedBody = rfc3986(querystring.stringify(urlencodedBodyBuilder(body.urlencoded).form));
            hash.update(urlencodedBody);

            return callback(hash.digest(digestEncoding));
        }

        if (body.mode === RequestBody.MODES.formdata) {
            // @todo: This requires adding new data to form instead of setting headers for AWS auth

            return callback();
        }

        if (body.mode === RequestBody.MODES.file) {
            originalReadStream = _.get(body, 'file.content');

            if (!originalReadStream) {
                return callback();
            }

            originalReadStream.cloneReadStream(function (err, clonedStream) {
                if (err) { return callback(); }

                clonedStream.on('data', function (chunk) {
                    hash.update(chunk);
                });

                clonedStream.on('end', function () {
                    callback(hash.digest(digestEncoding));
                });
            });
        }
    };

/**
 * @implements {AuthHandlerInterface}
 */
module.exports = {
    /**
     * @property {AuthHandlerInterface~AuthManifest}
     */
    manifest: {
        info: {
            name: 'awsv4',
            version: '1.0.0'
        },
        updates: [
            {
                property: 'Authorization',
                type: 'header'
            },
            {
                property: 'X-Amz-Date',
                type: 'header'
            },
            {
                property: 'X-Amz-Security-Token',
                type: 'header'
            },
            {
                property: 'Content-Length',
                type: 'header'
            },
            {
                property: 'Content-Type',
                type: 'header'
            },
            {
                property: 'Host',
                type: 'header'
            }
        ]
    },

    /**
     * Initializes a item (fetches all required parameters, etc) before the actual authorization step.
     *
     * @param {AuthInterface} auth
     * @param {Response} response
     * @param {AuthHandlerInterface~authInitHookCallback} done
     */
    init: function (auth, response, done) {
        done(null);
    },

    /**
     * Checks the item, and fetches any parameters that are not already provided.
     *
     * @param {AuthInterface} auth
     * @param {AuthHandlerInterface~authPreHookCallback} done
     */
    pre: function (auth, done) {
        done(null, true);
    },

    /**
     * Verifies whether the request was successful after being sent.
     *
     * @param {AuthInterface} auth
     * @param {Requester} response
     * @param {AuthHandlerInterface~authPostHookCallback} done
     */
    post: function (auth, response, done) {
        done(null, true);
    },

    /**
     * Generates the signature, and returns the Authorization, X-Amz-Date and Content-Type headers.
     * AWS v4 auth mandates that a content type header be present in each request.
     *
     * @param {Object} params
     * @param {Object} params.credentials Should contain the AWS credentials, "accessKeyId" and "secretAccessKey"
     * @param {String} params.host Contains the host name for the request
     * @param {String} params.path Contains the complete path, with query string as well, e.g: /something/kane?hi=ho
     * @param {String} params.service The name of the AWS service
     * @param {String} params.region AWS region
     * @param {String} params.method Request method
     * @param {String} params.body Stringified request body
     * @param {Object} params.headers Each key should be a header key, and the value should be a header value
     */
    computeHeader: function (params) {
        return aws4.sign(params, params.credentials);
    },

    /**
     * Signs a request.
     *
     * @param {AuthInterface} auth
     * @param {Request} request
     * @param {AuthHandlerInterface~authSignHookCallback} done
     */
    sign: function (auth, request, done) {
        var signedData,
            params = auth.get([
                'accessKey',
                'secretKey',
                'sessionToken',
                'service',
                'region'
            ]),
            self = this;

        // Clean up the request (if needed)
        request.removeHeader('Authorization', {ignoreCase: true});
        request.removeHeader('X-Amz-Date', {ignoreCase: true});
        request.removeHeader('X-Amz-Security-Token', {ignoreCase: true});

        // Removed the code which was adding content-type header if it is not there in the request. Because
        // aws4 does not require content-type header. It is only mandatory to include content-type header in signature
        // calculation if it is there in the request.
        // Refer: https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html#canonical-request

        // aws4 module can't calculate body hash for body with ReadStream.
        // So we calculate it our self and set 'X-Amz-Content-Sha256' header which will be used by aws4 module
        // to calculate the signature.
        computeBodyHash(request.body, 'sha256', 'hex', function (bodyHash) {
            bodyHash && request.upsertHeader({
                key: BODY_HASH_HEADER,
                value: bodyHash,
                system: true
            });

            signedData = self.computeHeader({
                credentials: {
                    accessKeyId: params.accessKey,
                    secretAccessKey: params.secretKey,
                    sessionToken: params.sessionToken || undefined
                },
                host: request.url.getRemote(),
                path: request.url.getPathWithQuery(),
                service: params.service || 'execute-api', // AWS API Gateway is the default service.
                region: params.region || 'us-east-1',
                method: request.method,
                body: undefined, // no need to give body since we are setting 'X-Amz-Content-Sha256' header
                headers: _.transform(request.getHeaders({enabled: true}), function (accumulator, value, key) {
                    accumulator[key] = value;
                }, {})
            });

            _.forEach(signedData.headers, function (value, key) {
                request.upsertHeader({
                    key: key,
                    value: value,
                    system: true
                });
            });

            return done();
        });
    }
};
