/*********************************************************************************************************************
 *  Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.                                           *
 *                                                                                                                    *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance    *
 *  with the License. A copy of the License is located at                                                             *
 *                                                                                                                    *
 *      http://www.apache.org/licenses/LICENSE-2.0                                                                    *
 *                                                                                                                    *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES *
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions    *
 *  and limitations under the License.                                                                                *
 *********************************************************************************************************************/

const AWS = require('aws-sdk');
const sharp = require('sharp');

class ImageHandler {

    /**
     * Main method for processing image requests and outputting modified images.
     * @param {ImageRequest} request - An ImageRequest object.
     */
    async process(request) {
        const originalImage = request.originalImage;
        const edits = request.edits;
        if (edits !== undefined) {
            const modifiedImage = await this.applyEdits(originalImage, edits);
            if (request.outputFormat !== undefined) {
                modifiedImage.toFormat(request.outputFormat);
            }
            const bufferImage = await modifiedImage.toBuffer();
            return bufferImage.toString('base64');
        } else {
            return originalImage.toString('base64');
        }
    }

    /**
     * Applies image modifications to the original image based on edits
     * specified in the ImageRequest.
     * @param {Buffer} originalImage - The original image.
     * @param {Object} edits - The edits to be made to the original image.
     */
    async applyEdits(originalImage, edits) {
        if (edits.resize === undefined) {
            edits.resize = {};
            edits.resize.fit = 'inside';
        }

        const image = sharp(originalImage, { failOnError: false });
        const metadata = await image.metadata();
        const keys = Object.keys(edits);
        const values = Object.values(edits);

        // Apply the image edits
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            const value = values[i];
            if (key === 'overlayWith') {
                let imageMetadata = metadata;
                if (edits.resize) {
                    let imageBuffer = await image.toBuffer();
                    imageMetadata = await sharp(imageBuffer).resize({ edits: { resize: edits.resize }}).metadata();
                }

                const { bucket, key, wRatio, hRatio, alpha } = value;
                const overlay = await this.getOverlayImage(bucket, key, wRatio, hRatio, alpha, imageMetadata);
                const overlayMetadata = await sharp(overlay).metadata();

                let { options } = value;
                if (options) {
                    if (options.left) {
                        let left = options.left;
                        if (left.endsWith('p')) {
                            left = parseInt(left.replace('p', ''));
                            if (left < 0) {
                                left = imageMetadata.width + (imageMetadata.width * left / 100) - overlayMetadata.width;
                            } else {
                                left = imageMetadata.width * left / 100;
                            }
                        } else {
                            left = parseInt(left);
                            if (left < 0) {
                                left = imageMetadata.width + left - overlayMetadata.width;
                            }
                        }
                        options.left = parseInt(left);
                    }
                    if (options.top) {
                        let top = options.top;
                        if (top.endsWith('p')) {
                            top = parseInt(top.replace('p', ''));
                            if (top < 0) {
                                top = imageMetadata.height + (imageMetadata.height * top / 100) - overlayMetadata.height;
                            } else {
                                top = imageMetadata.height * top / 100;
                            }
                        } else {
                            top = parseInt(top);
                            if (top < 0) {
                                top = imageMetadata.height + top - overlayMetadata.height;
                            }
                        }
                        options.top = parseInt(top);
                    }
                }

                const params = [{ ...options, input: overlay }];
                image.composite(params);
            } else if (key === 'smartCrop') {
                const options = value;
                const imageBuffer = await image.toBuffer();
                const boundingBox = await this.getBoundingBox(imageBuffer, options.faceIndex);
                const cropArea = this.getCropArea(boundingBox, options, metadata);
                try {
                    image.extract(cropArea)
                } catch (err) {
                    throw ({
                        status: 400,
                        code: 'SmartCrop::PaddingOutOfBounds',
                        message: 'The padding value you provided exceeds the boundaries of the original image. Please try choosing a smaller value or applying padding via Sharp for greater specificity.'
                    });
                }
            } else if (key === 'TEPWatermark') {
                let imageMetadata = metadata;
                if (edits.resize) {
                    let imageBuffer = await image.toBuffer();
                    imageMetadata = await sharp(imageBuffer).resize({ edits: { resize: edits.resize }}).metadata();
                }
                const { bucket, key, wRatio, hRatio, alpha, options } = value;
                const { name = ''} = options;
                const overlay = await this.getOverlayImage(bucket, key, wRatio, hRatio, alpha, imageMetadata);
                const watermark = new Buffer(`<svg version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" preserveAspectRatio="xMidYMid meet" viewBox="0 0 340 140" width="340" height="140"><defs><path d="M18.11 0L340 0L340 30L18.11 30L18.11 0Z" id="aL4kaXwLB"></path><linearGradient id="gradientb1nznF2gk" gradientUnits="userSpaceOnUse" x1="340" y1="15" x2="200.91" y2="15"><stop style="stop-color: #ffffff;stop-opacity: 0.22" offset="0%"></stop><stop style="stop-color: #dddddd;stop-opacity: 1" offset="100%"></stop></linearGradient><path d="M26.94 3.92L113.82 3.92L113.82 26.08L26.94 26.08L26.94 3.92Z" id="a1JZ8Le9rJ"></path><clipPath id="clipc3jA6tEaBa"><use xlink:href="#a1JZ8Le9rJ" opacity="1"></use></clipPath><text id="bnd4bwrWA" x="580.12" y="436.24" font-size="14" font-family="Open Sans" font-weight="normal" font-style="normal" letter-spacing="0" alignment-baseline="before-edge" transform="matrix(1 0 0 1 -272.5 -430.7389439469181)" style="line-height:100%" xml:space="preserve" dominant-baseline="text-before-edge"><tspan x="580.12" dy="0em" alignment-baseline="before-edge" dominant-baseline="text-before-edge" text-anchor="end">${name}</tspan></text><style id="opensansnormalnormal">
                @font-face {
                font-family: "Open Sans";
                font-weight: normal;
                }
                </style></defs><g><g><g><use xlink:href="#aL4kaXwLB" opacity="1" fill="url(#gradientb1nznF2gk)"></use></g><g><g clip-path="url(#clipc3jA6tEaBa)" opacity="1"><image xlink:href="data:image/png;base64,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" x="0" y="0" width="200" height="51" transform="matrix(0.434426229508198 0 0 0.434426229508198 26.93751484913271 3.922131147540952)"></image></g></g><g id="b1dlsvVBbB"><use xlink:href="#bnd4bwrWA" opacity="1" fill="#000000" fill-opacity="1"></use></g></g></g></svg>`)
                const params = [{ ...options, input: watermark }];
                image.composite(params);
            } else {
                image[key](value);
            }
        }
        // Return the modified image
        return image;
    }

    /**
     * Gets an image to be used as an overlay to the primary image from an
     * Amazon S3 bucket.
     * @param {string} bucket - The name of the bucket containing the overlay.
     * @param {string} key - The keyname corresponding to the overlay.
     */
    async getOverlayImage(bucket, key, wRatio, hRatio, alpha, sourceImageMetadata) {
        const s3 = new AWS.S3();
        const params = { Bucket: bucket, Key: key };
        try {
            const { width, height } = sourceImageMetadata;
            const overlayImage = await s3.getObject(params).promise();
            let resize = {
                fit: 'inside'
            }

            // Set width and height of the watermark image based on the ratio
            const zeroToHundred = /^(100|[1-9]?[0-9])$/;
            if (zeroToHundred.test(wRatio)) {
                resize['width'] = parseInt(width * wRatio / 100);
            }
            if (zeroToHundred.test(hRatio)) {
                resize['height'] = parseInt(height * hRatio / 100);
            }

            // If alpha is not within 0-100, the default alpha is 0 (fully opaque).
            if (zeroToHundred.test(alpha)) {
                alpha = parseInt(alpha);
            } else {
                alpha = 0;
            }

            const convertedImage = await sharp(overlayImage.Body)
                .resize(resize)
                .composite([{
                    input: Buffer.from([255, 255, 255, 255 * (1 - alpha / 100)]),
                    raw: {
                        width: 1,
                        height: 1,
                        channels: 4
                    },
                    tile: true,
                    blend: 'dest-in'
                }]).toBuffer();
            return Promise.resolve(convertedImage);
        } catch (err) {
            return Promise.reject({
                status: err.statusCode ? err.statusCode : 500,
                code: err.code,
                message: err.message
            })
        }
    }

    /**
     * Calculates the crop area for a smart-cropped image based on the bounding
     * box data returned by Amazon Rekognition, as well as padding options and
     * the image metadata.
     * @param {Object} boundingBox - The boudning box of the detected face.
     * @param {Object} options - Set of options for smart cropping.
     * @param {Object} metadata - Sharp image metadata.
     */
    getCropArea(boundingBox, options, metadata) {
        const padding = (options.padding !== undefined) ? parseFloat(options.padding) : 0;
        // Calculate the smart crop area
        const cropArea = {
            left : parseInt((boundingBox.Left*metadata.width)-padding),
            top : parseInt((boundingBox.Top*metadata.height)-padding),
            width : parseInt((boundingBox.Width*metadata.width)+(padding*2)),
            height : parseInt((boundingBox.Height*metadata.height)+(padding*2)),
        }
        // Return the crop area
        return cropArea;
    }

    /**
     * Gets the bounding box of the specified face index within an image, if specified.
     * @param {Sharp} imageBuffer - The original image.
     * @param {Integer} faceIndex - The zero-based face index value, moving from 0 and up as
     * confidence decreases for detected faces within the image.
     */
    async getBoundingBox(imageBuffer, faceIndex) {
        const rekognition = new AWS.Rekognition();
        const params = { Image: { Bytes: imageBuffer }};
        const faceIdx = (faceIndex !== undefined) ? faceIndex : 0;
        try {
            const response = await rekognition.detectFaces(params).promise();
            return Promise.resolve(response.FaceDetails[faceIdx].BoundingBox);
        } catch (err) {
            console.log(err);
            if (err.message === "Cannot read property 'BoundingBox' of undefined") {
                return Promise.reject({
                    status: 400,
                    code: 'SmartCrop::FaceIndexOutOfRange',
                    message: 'You have provided a FaceIndex value that exceeds the length of the zero-based detectedFaces array. Please specify a value that is in-range.'
                })
            } else {
                return Promise.reject({
                    status: 500,
                    code: err.code,
                    message: err.message
                })
            }
        }
    }
}

// Exports
module.exports = ImageHandler;
