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
                const { options } = value;
                const { name = '', style = ''} = options;
                let watermark;
                let imageMetadata = metadata;
                if (edits.resize) {
                    let imageBuffer = await image.toBuffer();
                    imageMetadata = await sharp(imageBuffer).resize({ edits: { resize: edits.resize }}).metadata();
                }
                // if (imageMetadata.width < 341) {
                //     watermark = new Buffer(`<svg id="Layer_1" data-name="Layer 1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 150 50"><defs><style>.cls-1{opacity:0.2;}.cls-2{font-size:10px;font-family:OpenSans-Bold, Open Sans;font-weight:700;text-anchor: middle;}.cls-2,.cls-3{fill:#fff;}</style></defs><g class="cls-1"><rect width="150" height="50"/></g><text class="cls-2" transform="translate(76.56 17.59)">${name}</text><path class="cls-3" d="M55.65,41.77a4.75,4.75,0,0,1-1.81-2,5.91,5.91,0,0,1-.59-2.66,5.81,5.81,0,0,1,.58-2.63,4.8,4.8,0,0,1,1.8-2,5,5,0,0,1,1.6-.59V30.89L48.4,26.33l-8.83,4.56V44H57.23V42.35A4.62,4.62,0,0,1,55.65,41.77Zm-3.31-1H44.7V31.58h7.5v2.1H47.42v1.44h4.34v2.09H47.42v1.46h4.92Z"/><path class="cls-3" d="M62.51,31v9.72h-2v-1a2.57,2.57,0,0,1-.94.83,2.8,2.8,0,0,1-1.28.28,3.33,3.33,0,0,1-1.75-.45A3,3,0,0,1,55.36,39a4.25,4.25,0,0,1-.41-1.9,4.12,4.12,0,0,1,.4-1.87A3.07,3.07,0,0,1,56.51,34a3.35,3.35,0,0,1,1.71-.44,2.61,2.61,0,0,1,2.28,1.11V31ZM60,38.59a2.26,2.26,0,0,0,0-2.81,1.74,1.74,0,0,0-2.54,0,2.22,2.22,0,0,0,0,2.81,1.74,1.74,0,0,0,2.54,0Z"/><path class="cls-3" d="M71,33.64V40a3.09,3.09,0,0,1-.47,1.73A3,3,0,0,1,69.2,42.9a4.53,4.53,0,0,1-2,.4,5.26,5.26,0,0,1-1.64-.25,5.32,5.32,0,0,1-1.42-.68L64.92,41a3.68,3.68,0,0,0,2.18.7,2.11,2.11,0,0,0,1.38-.42A1.43,1.43,0,0,0,69,40.09v-.8a2.24,2.24,0,0,1-.89.76,2.71,2.71,0,0,1-1.23.26,3.07,3.07,0,0,1-1.61-.42,2.86,2.86,0,0,1-1.08-1.2,3.89,3.89,0,0,1-.39-1.78,3.76,3.76,0,0,1,.39-1.75A2.84,2.84,0,0,1,65.26,34a3.07,3.07,0,0,1,1.61-.42,2.6,2.6,0,0,1,2.12,1v-1Zm-2.46,4.64a2.12,2.12,0,0,0,0-2.64,1.64,1.64,0,0,0-2.38,0A1.89,1.89,0,0,0,65.68,37a1.93,1.93,0,0,0,.46,1.32,1.68,1.68,0,0,0,2.39,0Z"/><path class="cls-3" d="M78.32,34.55a4,4,0,0,1,.88,2.74c0,.21,0,.37,0,.48h-5a1.84,1.84,0,0,0,.65,1,1.9,1.9,0,0,0,1.17.37,2.37,2.37,0,0,0,1-.19,2.54,2.54,0,0,0,.83-.56l1.06,1.08a3.5,3.5,0,0,1-1.31.92,4.44,4.44,0,0,1-1.7.32,4,4,0,0,1-2-.45,3.08,3.08,0,0,1-1.28-1.25,3.82,3.82,0,0,1-.45-1.88,3.88,3.88,0,0,1,.45-1.89A3.28,3.28,0,0,1,73.85,34a3.87,3.87,0,0,1,1.88-.45A3.32,3.32,0,0,1,78.32,34.55Zm-1,2a1.55,1.55,0,0,0-.44-1.11,1.5,1.5,0,0,0-1.11-.42,1.58,1.58,0,0,0-1.1.41,1.89,1.89,0,0,0-.55,1.12Z"/><path class="cls-3" d="M87,32.34a2.94,2.94,0,0,1,1,2.33,3.15,3.15,0,0,1-1,2.44,3.82,3.82,0,0,1-2.68.87h-2v2.7H80.55V31.51h3.76A4,4,0,0,1,87,32.34ZM85.75,36a1.58,1.58,0,0,0,.53-1.29,1.52,1.52,0,0,0-.53-1.26,2.51,2.51,0,0,0-1.53-.41H82.31v3.39h1.91A2.44,2.44,0,0,0,85.75,36Z"/><path class="cls-3" d="M91.86,34a2.86,2.86,0,0,1,1.42-.37v1.65a2.31,2.31,0,0,0-1.73.5,2,2,0,0,0-.65,1.54v3.38H89.2v-7h1.7V35A2.62,2.62,0,0,1,91.86,34Z"/><path class="cls-3" d="M99.33,34.07a3.17,3.17,0,0,1,1.29,1.25,3.63,3.63,0,0,1,.47,1.85,3.68,3.68,0,0,1-.47,1.87,3.19,3.19,0,0,1-1.29,1.26,4.36,4.36,0,0,1-3.86,0A3.16,3.16,0,0,1,94.17,39a3.68,3.68,0,0,1-.47-1.87,3.63,3.63,0,0,1,.47-1.85,3.13,3.13,0,0,1,1.3-1.25,4.36,4.36,0,0,1,3.86,0ZM96,35.67a2.4,2.4,0,0,0,0,3.06,1.87,1.87,0,0,0,1.44.59,1.85,1.85,0,0,0,1.41-.59,2.4,2.4,0,0,0,0-3.06,1.81,1.81,0,0,0-1.41-.59A1.84,1.84,0,0,0,96,35.67Z"/><path class="cls-3" d="M108.3,34.07a3,3,0,0,1,1.16,1.27,4.38,4.38,0,0,1,0,3.72,3,3,0,0,1-1.15,1.24,3.31,3.31,0,0,1-1.73.45,3.09,3.09,0,0,1-1.39-.31,2.59,2.59,0,0,1-1-.9v3.68H102.5V33.67h1.71v1.16a2.46,2.46,0,0,1,1-.9,2.92,2.92,0,0,1,1.38-.31A3.32,3.32,0,0,1,108.3,34.07Zm-.7,4.61a2.38,2.38,0,0,0,0-3,2,2,0,0,0-2.84,0,2.39,2.39,0,0,0,0,3,2,2,0,0,0,2.84,0Z"/></svg>`)
                // }else {
                //     watermark = new Buffer(`<svg id="Layer_1" data-name="Layer 1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 340 140"><defs><style>.cls-1{fill:#fff;opacity:0.75;}.cls-2{font-size:14px;font-family:OpenSans-Bold, Open Sans;font-weight:700;text-anchor: end;}</style></defs><rect class="cls-1" width="340" height="40.47"/><text class="cls-2" transform="translate(329.29 25.75)">${name}</text><image width="200" height="51" transform="translate(9.4 9.58) scale(0.42)" xlink:href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMgAAAAzCAYAAADSDUdEAAAZXklEQVR4Xu1dd5xU5bl+3jOzu1TpJSIKSu9BU/x5g2ujV3UBQUWDUnYBJfXGRO+Ydm+898ZI2WVRQ8QaVqSXYEMTRUMwsjQRkZWidBCk7M7MefN7ZmeWM2fOmZ2dnTWI8/4FO+cr5/u+53vb831HUFMydUZWs2Oe1gFPxoOAZqsa06SWufZY4YQTENGaajZdb3oEUjkCksrKQnVNKMxoEPD2NILBHEDHAnIxoGynFJB1gmCBP8t47eTciYdT3na6wvQIpHgEUggQlSZ3ze2oiskKDAVwGYDY+lW/EJF3AHnc8HhWHf7j+JMpfqd0dekRSNkIpAQgzXJm1/PX8/okiHEQNATgjd9Dmlh6BtBiQ733HZl/z99T9kbpitIjkMIRqAZAVJrePrel6cUoVfwUQMtq9Gu1ieAv6mZ5tn06d+LpatSTLpoegZSOQNUBoioNxhe09QQ816vofYB0BuBJQa+OQlCkMF+ok2n8PQ2UFIxouopqj0CVANJ47IyLxJt1lwmMA6QboJnV7kFUBSHT6wAEb5iCRz6/7LP34fOZqW0jXVt6BBIfgcQA4vMZDXe2uBMe4wHRkPOdYmDEdJigOAnFCn+d2tO/mHPnwcRfKf1kegRSNwJxAdLwrnkNIf6eUP29KHoBMFLXdII1KRj1+oMpwSePlxzYi7W+QIIl04+lR6DaI+AIkAZj8huJN6OPQCdANBtAnWq3VL0KTCg+AfCEeDIWH71s9wdp06t6A5oundgIxACk8R1z+yn0foh8F1CGbM8nCQLYISILPOIvOPSnvP3nU+fSfbnwRqACII3Hze2KIJ5QUZpSWY5JvvPn/QMKHDNUHzla2vhRFI0kcNKSHoGUj4A0uePxzqrmTxU6EkDtlLdQoxWGOF07AX3IWxpcdqgo74t4zbUbMCPrSL2sWvZnjh367FTat6nRifrKVi6Nx8zZroZ0+Mq+Qajj6lcTOcefm7TE9T18PqPpthYDBXK3/ZlgIPDQ0YVTtny1xyDd+5oYAWk0pnAfBBfXROVfZp0CHX302Ul/jg+Q5tNE5VH7M6qafbgo940vs7812FZbAJdWoX5y4T4CcKIKZb42j5YDBJoMQPZ4/cFvp3Kkgt6MJirm5mTqFEGlAGmxufk0lViAmLigAPIrAD+uwhjSTGXe6RiAbQB+BuAfVSh/QT8qjW4r3KeSBEAUJcefn8TdKmVSL2dGM29GZqJJQTrmewD9BCILpUzmHyua+Hk8DRICCBwAIhcUQP4bwH9WY1L8AF4FMB3Adtqv1ajrK19UGt+WtAYpOVoDAMn0VgYQUVXshGhRUDDvRD0pwdyJnNT44vMZLYqbT1MjDZDKhir8+wEAYwG89nUGiTQZnRxAFCg5+kLqNUiWpzKA6Gum6PRj9T3bEgJGZDWEASKCGB8EBrL3Xzg+SHU1iBU/HwIYDeCfCYLqgntMmo4q2AdU3UknQI78eXLKTaxaRkY8E+vZw7UP3IM/+c5WeSZ8PuMbxc2nwcEHUUMvdIA8F/Yt7MPGsP4VYZ+ljwOViOZVAYAfAThT5TG/AAqEAcJjsVWTcoC4axDSVWqdRaOq1BqUYGN4M9Y7lKEJteBwA7nbSWtckrOgtgaOtzYN8yLDDGSoR8Rjwh8U78lgndp7Djx95ymEASJOPohq9v5FcaNY0m7sM/VPnf68lVdQT02jPMHq0bMwMvfuLbrnKP/bZvi8hgEta23vv1E3uHf3c7l0guOJXDyksIk3099C4a2tQQ3x3oIeMdXA6cwM87Pdz+UeT8DccdIgcwFMjNM436cpgJcAXG07vkCKD8GzO1w+A0ArG5gIJP4eSdiy7y3CdZYCoCZyEz7LdcL2CVj2hUGDUwBo5iV64pRHLkiktQrzYjzaHWGEkzLFc0v1w/1nfzmmbIf9jBFpOrJgnyShQQCUHFrgrkGajiyYLorJVQEIoF6IRGslEuAh7wb8Ovr44sklUfXlLPC0Ch4jZ2ysqg4QQVNVGBCIAKZCj0ONVYA+ta/ngbWtqEEcACKq2XvdAMI2AofGiniGKPQ6AS6K9EGhZYC8YSiezvAaq0pNs5+YmOfwzhP2Lpr8rNtYtBoxpyfEHCSQPlD5DoTct9A5fr48F98pBd4S0TVejxaVFMWl2CQDkEjXvgFgFYCelr5yEV0H4K/hv3EDWAqgruUZ9vE74cVGJsbNAG4A0B3AhnB5++uTrcFnvgvgWwC+CaCBBSC0JN4NR9T+AoDRzXhHH0iLsp9MXRMOWBBsIwAMDoOdCoHAZH07AbwN4BUAbCcq3C3NcpIHyMEid4A0GznnV6L6i6oBxPFp7iDjDhYdWAJYzoZk+7ytGzWfqwAXVrOKBRW7B3DyDkL0cdPEEcPBB1HAESCtbn78EsP056uB60WjFoS9lRMSWjTGywrzKfuPAmPc7kWT5tv/zsx+ae3M8VDzhwq0kUrZ0lIm0K2m4oG9i3O5kJ2kOgDhLswQ8W9tVCNGtP4Qbowm2XuwbBThhcad+SYADDNzk4vQmLj4rrF1lL//BkC/sPaIxyonQKmdFgP4CQA3NneTsLawNrUQCJ12/T0Akm6pOdzaIjDoa90G4LNIJdL81uR8EChKDi6MA5Bb5/xKkAKACN46WDTpe4DlqqCcBZ5L/Ue4iw2sAgA5sDQXOMFRYkqsBrliREFzv8pCQP8j0TYEOKnlkxAtIo4AuXRY/kMQ+a8kjhGchJpjdy/JW+bQt+oAhNXdAoS0oPU9fg3gwUoAMhwAfZ16tj7ZAUItwV2bC7oqwo2uOAw2agS7OAFkZdjs6lqFhnjkm9owlI9LGiCiKDkQByDNby14EJp4wkoEXlWpBQmbFhVvZPY7+GIeVWVIrryyMONwa3MaoNypUsIdE0F2icXEunJCYcbhg8GHADyQxOKNmQtDjXG7llg1iMrlwwonB8Wc7TRxAilTwSGo6RVIYwVo99tls0fMWz5eNMVu31cXIDSPCJAKUzKsFTgeFCcNwsW7xyWDbwUINQeTkI1dFiytBS5+gshpbtnOIgDjw+actRongPB5q8agL3skrPHoj0RMOnt3qEmG8Z2k5c0FyVFNFCX7X3LXIBffUtgpoCbPqyckhoFrRJGngJVMWLLfaNLOyta9bMjMtobhWQ3AgT8WOrK7V0Veg4kDIqgHQR9V7RLPfFEjGiBthhe0EcU7gNLRjBbBJ1B5VssdO0C1pQiGAOjm/qLRAGk7NL8HRNbbjywrI0WqaxTGUhFjiyDIk5sdAYwCcKO1fuVOovj1rqwmD9vYzNUBCO3yXCAUCrfeTDMFQATMTgCxvzrNlbVhjb0DwMywKUUqEM0wq9APoMlGHt3WkDlcTpXhrn+XQ4SVAKLJ94QtYOEEkEg7BMrrDPSE2yBQmgHoDYT8ZPs883duwL+Ti0ckD5BPF6UuzHvxiILREDDaUqHaVXTOZwtzoxz9dsPm5KqaHHCn040vBTX4c29Ad320alopchZ42viPtDZU7xYV3vDoaH+KBrI/Wjatgot1xdB8Dk6s/yS6Lmh6v1+ybML2CpPP5zPavte8vUcwXxXO1BvRcTuX5IV8EGrAz1sFCbAc6yoR2tYicwNy9ucli6czslIh7QbMaKYZXi4I3jdWIQLsPK2eHp8ui7oJpjoAYTSJiygKjGGTI+IAxwMIzViajDRtdoUd3kgmniYYNZP9jBHf62EATDdYs/acKwYLngwvZOurU1tRG1mPOcQDCOeSa+tQzHZXvrE9Hwak9WcC+xq5ZETBPk2GrKgo2ZdCgLQeUTDatAFEDPOWvS/mMfRYIe2H5r8J4HuxGzte/3Bp7vVuu3j7ofmPuHGU1AaQ9kMLNgLaI6ouwUEYmr1jUR75SjFy+bDC7h4N0nyIOa8vouM+DAOkw5CZnVQ89J/a2yo5nJGlbbe6UPY7Dp1zlQmTmtNmuxvX7lg6iWMSkWQBQgfd57AxfBx2cLkoKW4AYZiUmoYL2k5Pobn0GIB7be9MU4a7eDxhdIsOup2AyQ3mRUtBN4DQJKPZGE9ojdAUtPtF/aU1NUiSYd49KQaIAIxKlWsQ1YD40XH3ilxOUIV0GJp/HBqyHStEgC/8avT+ePkkot5R2g2YcZHh9XJCLrc/YCCQ/UFYg3TJWZAZOHs4JiYukKezSutOLl5zp5ODGKqy45D8pYqQuRUtquM+XF6uQToNnjPElOB8QKJ2UhH8entWUy5QR+lw5khLQJ+H2DYH0Yc/XJpnLecEEC4k7tJ2oRnF8WZ4l7ssw7JWofnDHf4HYd+Av7kBhAGDMQCczuQwwsXfr7JUzjFmmPctt3cO/50bDs2779ushhfCEadIcSeA0NSjSVfZxYT0Rxilu8fms8yQS4fn7yu/P7dqIkDJJ4tTZ2K1GVEwWtUCEOCYmoFue5ZO/TTSs679nmgczCijkxUtgjdUsoZsX+p+jSkXvp45/JgCk2LLWwAycF5L0zhTEebjsxpS5frA9uV51EKu0mFwfp4BzIrtno7bFgHIkPwJ0NCER98+KVgNcsxcRIEsAagh7QB/4YPluQxNRsQJIIzMOBE56e/FS+ZSazCqZU3eujnpNP+Wu3SfZWjCMsEYkZAJ42D2OFVxKwCGz613I5BI2cnysBNA2G/mP6gEKhP6O5wXaxtrpc2w5ADCRGHJkjgA8fmM7LXXJnwLyq6LPhglEqI1RHyQPaLeb+1aem+5Mwygy+DCSxVBhmqjRTXfbwZ/EPI73CRngafT6SP3i+j/xRSXaICoDSAATgswZevyXKckYEV1nYbkjxGFQ0LwHEA6DimYZqjS3EiNiL65bVnetZUAJJm2aN/TjOGit5JB3fIgNIHcFiIDDUz6WTX/31CubaP8LZeOMpH4sq18WfhoeKSIE0Do+HPhJ9LGAABP28ysDXLFsPx9mqSJ9fGSXFcuFh1dFQdHN/Gp2q1a9u1dS++PAgg0FiAi8pjWbvKTrUUjOWjO4vMZndc3nyblEZoo8RiB7E1hE6vb0D+0MIOZ0ZdBKPwQ/dnWFXn/H6/7XYYWTEFQGUCIEvogW0IaRKXLwILpEMStJ/EhYgxT396yIs+aiKsuWZFmFU0TLph3HPriBpDm4RCqU/e50xMg1tAxNQpDqe5HFM7VRD+FrGIrwOjnWDdgJ4DQ/+AJ0kTaYNKSm5vVD9kg7YdSg1SdrEgNsmOpO0Dau0WCEp191ROGmJ23W0ysDkMKm2YETWbFo6NRiuWeQL3R8fwDRo/OtAg+LBI6EBQlhhnI3rTqXBSr66B8xuOjEl4CedasY05yc6KRk+Ppcvq61RIbAWLAKwwQoOug2bmAxEThVFFiiET4TomOEs2/zVtWTM6rRINw0ce72CICCkaeuBBnWLPJts4kA5B2AKgxrOFUhnbpH4R4bJVIXwDMilvnhJZEG0s5J4CsA0DzrMJMj9POHWFippVC87Z0HJI8QLYvcwdIRwJEq6FBBH7DNLpuszneXQfmc0Cj7WbFZ16PfGvj8smutmaX7Nn1jDp4XSFWRzE0XobaAVLwClTpQFplvwfm8OKVU7gTxkjXATOvATyvQKLyOOXPqY7bsqrcSe82aPbNaso8SNRuSt/w+S0rJ/F7KtU9oOSkQegIM5TpJvRRCE7ypiozR5IBCH0Phn6tkUFuQpyLeERG9pebIQMM3NisftuKMLcq8k5OACFRkeCqjK5PX+x/AEy1aaWnpfPgJAGiKNm2wh0gnQe75BIq2yssv4ti5NYVuUXWIt36F7zOL1ZFV8NFZc7dvJo5E+cF1r1f/t0qmOMcho0GSPf++RMUKIxtQ7fB1P6b1+RFQp5c/dJzwJxeQegf+U+nXItSg4QB0nXwnJ4ImIslevfjMjiuqn23rM5zYjOXd8XnM77596at/7lySqwfdq6zyYZ5E52ZZADCnZ/+5e22RujTMToVT2jGU3sw3GsVZtP/aPmDWyadzn3MRR22uugj8RSlNYjARyZJ50H5SbF5aRJsWxkPILN6C9TKCk1sAkzPBEiI4UmZu3VFbhRNu1vfgskwlNGGmKSfiPy03vEzM9etO1EK+EI84C5dHs4w2rS8FqZZQVexd0TEpkH6PdFYpIyhwRjeFmkKAjxhqr6g1HIqYyAh6oPrfcVWgJCgWAsZy6BqzyjzlTaaGhy79erD26JvjvQZHYe2rpvpL52uip+JYeRuqtt4vst9YOcjQDjkBAJNS/stnXSiafs7kRCZP+H73GebM/oUDB1bzwXFSxTeDyDfFmyIaCf6NcxL2XNrbKOLdKkGQLbGAUhiaIh9qtuggmc09Om2EAI+Nus07Wx1vnv0fbytGgFS2Il6uwRIPxfTfMk0sB+m0dAw9CZVDHc0fSKlbQDJzvZ5D2e2uFdEHwHpKglLiOoSC1zVccV/KTexKN0H5A+AiSUQB46VYo8KCgTmRjE9Z03R2qLaASK3QUK0cMppVfyw/kVnn1pX9AP7QabzFSDcnbkQ7YlB9p/a+pmwmceIGcecmxOBwTCtVQgkmkPkhlnN0cqoJhz/PwHYGz77wTxUFwC/dKAt0SejSTpRug7IT5qLtWWVuwZJeE3ZHgwBRMsBEgKJar/Nq86RFZnPME4cmiq0S+NT0BPvggazN718zklnwU43zGqS4ZHfQHAPNJHvn4gfgregdvMPPJwSBRAGDMqaBGZCcC94fiU5OSDAvcVrcpfbzMrzFSB8S5rG9EXsREQudOaePggvXpIZycWyb058jo43jwFbzNzQALqZWKFlFB5i+j00T+lzMep2icvX0PgMk57rpGv/JE0soGTL6hoAyICCZ2ABCCkAWYc82Rs2nLuYgQ63NyNErY7NWrsvNu48EQ5P1FOKWIDwgStvLGwQEP99CuEtIfGYw2dU9LcKz6eGmqRaRIsRDRD+2PGa39XPqlP3GRUZLFUHiSrwDwn47yh+/X4mzKxyPgOEmwEPLdGkqoJmrng9HpgjbWSjw+EpJ4CQ+sOTitZoV2XbETUYM+rUIP7zDyD9C54p/zpuhXwhwPc3rZ78ot0B73nT7HlQjNLyyFG8QzelCjwuqjsdz6S7ACTSg+435F8uBn4T0g6i9UM6IaTetQwq7xtiPPj+y5Pf6t539ljRkKkQLYpxxa+cM7EiP3Yc+mT9rLNnfgkY46HKBVPZ91q4g56FYI2elrs3/c3xGO/5DJDIbs4zNqSwkBVQyfcsQ2YU81sMCzNb7/Z1ZLcDUzzLQi4XtUW8L6HRrGIEjyFz0lhCIt37zU6KaqKK3QZO0YZLrUjdJ7Wc3m2V9aLBUcVrpjJOf05yFni6HTvc3xDNhWo3qDSCIBMiQi4XoCcB2QHFY8XfO/RSj781pcPP03JREhQdvOXlqZVxgkJM3EBDf9sApIHHEzgDlO0qXvPjCm5WzxvyH1LRKM6TQAMqcmfxy3kuYVaf0evGFn1MBO+FSE9oyPmsDREvlHMmfI+zgByAyEYxde7GV/NI3XYT2uakg1uFtrf9b8nOG3djkiOtB6rYUZIvE8lpRNplTmQcgEFhZi6TiAQLtQxzNtzJWR81JKNd9F/cE8HOJhajXwwOcONhmJjJQAIlcvad4CP7gnkS5mmYwOUtkxUiPfoSIEklCk8B4nSiLdmBLy8n5tVQsR++9yuwQFB/olMysEff/61rBOt0McW81BCjvinwQHFaEfw001+2ZcPaH3HXke43PNrWQEYMqEuBdR+8OiWG48WIU4MzZfXD5eO+15XZhU2DHv87ComKfAlw2PQYo4rXTGYCzl18PqP3umaXB4PmFWpqY3g9dRA0AcM4DRPHBPqxv3HzkrhsgfLaGbywM4VpU2+q3sRUlGYijRrAeoiLC41UkHgL2K15Ao2ZdvIBuXAJEoKD/gIdanK2ErlRxU2DECBkBlB7EBxk7vLZSDuMVhEU3HxjkqnS46akAZKi8U64Gr8KVmZmecdsiD7/kHAFVX2w13WzBkJ0BsTzo9qnz/5l3bqYiFGoyl7Z8xqqcWoGBGMdnO5N6tVhMdqvqp1JP1/ZCFQGkMrKO/4uPW78ygAk8gJvmKZ3fOcmjUqKavC7IL2yH20oRuZiQMuJgIqPVKTQo/pXZGbsRulJv1/qNPGI+W2BTleIPZHFUqYpmLXx1bz7U5AhT2qCv0aFagYgPW+YvQ/J3M37bxx5Uew0oTMNv7mytj+4121nT76LPqP3dc2Ga8iR1Crd7RXVpsiOoNfsl9Yeyc9EFUrWDEB6XT8rWR+kCn2vkUeDgGyBmO8bMN6WoHfhhrUT3SIcVepAj77z62aUffFnhdKBTE4En4ji9g1r8+j8paXmR6BmAPJNAkSTctJr/pUTa0EhOGMCt298bQrpzdWWnJwFnp0HDw0UCd2ndIX7nVuOTdFhfQ+m3r3hzam8Oqa65MNqv8/XpIKaAUjv675yPojzfKs5+r21U90/oJPEKrk6Z0Ft/6Ej41WDEwC5FNBaAvFqdDyddx8GICgV6HEF8oPiL3h/bfTFC0k0ny5StRFg9t3+UVfeZzChOh8Hkt7Xzt4nyVzaULXO1/jTBszR61MMkEinGe5tdNrTw4ReZSg5YMIz3CExgTMC3aHQ9d5SvPPuu9PSX2qq8dl2bIAhYp6dtwqpKzwR6X7StJK+ypV9ZiXF5v33jIF7q/wE2/o3U6tBzrd3TPfnyx8BuarPzKdEXW+6+/J7lGSLQUMfee+NaZELlpOsJV0sPQLRI/Av09de+W2NFEQAAAAASUVORK5CYII="/></svg>`)
                // }
                if (style === 'cute'){
                    // watermark = new Buffer(`<svg id="Layer_1" data-name="Layer 1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 150 50"><defs><style>.cls-1{opacity:0.2;}.cls-2{font-size:10px;font-family:'OpenSans-Bold, Open Sans';font-weight:700;text-anchor: middle;}.cls-2,.cls-3{fill:#fff;}</style></defs><g class="cls-1"><rect width="150" height="50"/></g><text class="cls-2" transform="translate(76.56 17.59)">${name}</text><path class="cls-3" d="M55.65,41.77a4.75,4.75,0,0,1-1.81-2,5.91,5.91,0,0,1-.59-2.66,5.81,5.81,0,0,1,.58-2.63,4.8,4.8,0,0,1,1.8-2,5,5,0,0,1,1.6-.59V30.89L48.4,26.33l-8.83,4.56V44H57.23V42.35A4.62,4.62,0,0,1,55.65,41.77Zm-3.31-1H44.7V31.58h7.5v2.1H47.42v1.44h4.34v2.09H47.42v1.46h4.92Z"/><path class="cls-3" d="M62.51,31v9.72h-2v-1a2.57,2.57,0,0,1-.94.83,2.8,2.8,0,0,1-1.28.28,3.33,3.33,0,0,1-1.75-.45A3,3,0,0,1,55.36,39a4.25,4.25,0,0,1-.41-1.9,4.12,4.12,0,0,1,.4-1.87A3.07,3.07,0,0,1,56.51,34a3.35,3.35,0,0,1,1.71-.44,2.61,2.61,0,0,1,2.28,1.11V31ZM60,38.59a2.26,2.26,0,0,0,0-2.81,1.74,1.74,0,0,0-2.54,0,2.22,2.22,0,0,0,0,2.81,1.74,1.74,0,0,0,2.54,0Z"/><path class="cls-3" d="M71,33.64V40a3.09,3.09,0,0,1-.47,1.73A3,3,0,0,1,69.2,42.9a4.53,4.53,0,0,1-2,.4,5.26,5.26,0,0,1-1.64-.25,5.32,5.32,0,0,1-1.42-.68L64.92,41a3.68,3.68,0,0,0,2.18.7,2.11,2.11,0,0,0,1.38-.42A1.43,1.43,0,0,0,69,40.09v-.8a2.24,2.24,0,0,1-.89.76,2.71,2.71,0,0,1-1.23.26,3.07,3.07,0,0,1-1.61-.42,2.86,2.86,0,0,1-1.08-1.2,3.89,3.89,0,0,1-.39-1.78,3.76,3.76,0,0,1,.39-1.75A2.84,2.84,0,0,1,65.26,34a3.07,3.07,0,0,1,1.61-.42,2.6,2.6,0,0,1,2.12,1v-1Zm-2.46,4.64a2.12,2.12,0,0,0,0-2.64,1.64,1.64,0,0,0-2.38,0A1.89,1.89,0,0,0,65.68,37a1.93,1.93,0,0,0,.46,1.32,1.68,1.68,0,0,0,2.39,0Z"/><path class="cls-3" d="M78.32,34.55a4,4,0,0,1,.88,2.74c0,.21,0,.37,0,.48h-5a1.84,1.84,0,0,0,.65,1,1.9,1.9,0,0,0,1.17.37,2.37,2.37,0,0,0,1-.19,2.54,2.54,0,0,0,.83-.56l1.06,1.08a3.5,3.5,0,0,1-1.31.92,4.44,4.44,0,0,1-1.7.32,4,4,0,0,1-2-.45,3.08,3.08,0,0,1-1.28-1.25,3.82,3.82,0,0,1-.45-1.88,3.88,3.88,0,0,1,.45-1.89A3.28,3.28,0,0,1,73.85,34a3.87,3.87,0,0,1,1.88-.45A3.32,3.32,0,0,1,78.32,34.55Zm-1,2a1.55,1.55,0,0,0-.44-1.11,1.5,1.5,0,0,0-1.11-.42,1.58,1.58,0,0,0-1.1.41,1.89,1.89,0,0,0-.55,1.12Z"/><path class="cls-3" d="M87,32.34a2.94,2.94,0,0,1,1,2.33,3.15,3.15,0,0,1-1,2.44,3.82,3.82,0,0,1-2.68.87h-2v2.7H80.55V31.51h3.76A4,4,0,0,1,87,32.34ZM85.75,36a1.58,1.58,0,0,0,.53-1.29,1.52,1.52,0,0,0-.53-1.26,2.51,2.51,0,0,0-1.53-.41H82.31v3.39h1.91A2.44,2.44,0,0,0,85.75,36Z"/><path class="cls-3" d="M91.86,34a2.86,2.86,0,0,1,1.42-.37v1.65a2.31,2.31,0,0,0-1.73.5,2,2,0,0,0-.65,1.54v3.38H89.2v-7h1.7V35A2.62,2.62,0,0,1,91.86,34Z"/><path class="cls-3" d="M99.33,34.07a3.17,3.17,0,0,1,1.29,1.25,3.63,3.63,0,0,1,.47,1.85,3.68,3.68,0,0,1-.47,1.87,3.19,3.19,0,0,1-1.29,1.26,4.36,4.36,0,0,1-3.86,0A3.16,3.16,0,0,1,94.17,39a3.68,3.68,0,0,1-.47-1.87,3.63,3.63,0,0,1,.47-1.85,3.13,3.13,0,0,1,1.3-1.25,4.36,4.36,0,0,1,3.86,0ZM96,35.67a2.4,2.4,0,0,0,0,3.06,1.87,1.87,0,0,0,1.44.59,1.85,1.85,0,0,0,1.41-.59,2.4,2.4,0,0,0,0-3.06,1.81,1.81,0,0,0-1.41-.59A1.84,1.84,0,0,0,96,35.67Z"/><path class="cls-3" d="M108.3,34.07a3,3,0,0,1,1.16,1.27,4.38,4.38,0,0,1,0,3.72,3,3,0,0,1-1.15,1.24,3.31,3.31,0,0,1-1.73.45,3.09,3.09,0,0,1-1.39-.31,2.59,2.59,0,0,1-1-.9v3.68H102.5V33.67h1.71v1.16a2.46,2.46,0,0,1,1-.9,2.92,2.92,0,0,1,1.38-.31A3.32,3.32,0,0,1,108.3,34.07Zm-.7,4.61a2.38,2.38,0,0,0,0-3,2,2,0,0,0-2.84,0,2.39,2.39,0,0,0,0,3,2,2,0,0,0,2.84,0Z"/></svg>`)
                    watermark = new Buffer(`<svg id="Layer_1" data-name="Layer 1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 150 50"><defs><style>.cls-1{opacity:0.2;}.cls-2{font-size:12px;font-family:'OpenSans-SemiBold, Open Sans';font-weight:600;text-anchor: middle;}.cls-2,.cls-3{fill:#fff;}</style></defs><g class="cls-1"><rect width="150" height="50"/></g><text class="cls-2" transform="translate(76.33 40.59)">${name}</text><path class="cls-3" d="M55.65,19.77a4.75,4.75,0,0,1-1.81-2,5.91,5.91,0,0,1-.59-2.66,5.81,5.81,0,0,1,.58-2.63,4.8,4.8,0,0,1,1.8-2,5,5,0,0,1,1.6-.59V8.89L48.4,4.33,39.57,8.89V22H57.23V20.35A4.62,4.62,0,0,1,55.65,19.77Zm-3.31-1H44.7V9.58h7.5v2.1H47.42v1.44h4.34v2.09H47.42v1.46h4.92Z"/><path class="cls-3" d="M62.51,9v9.72h-2v-1a2.57,2.57,0,0,1-.94.83,2.8,2.8,0,0,1-1.28.28,3.33,3.33,0,0,1-1.75-.45A3,3,0,0,1,55.36,17a4.25,4.25,0,0,1-.41-1.9,4.12,4.12,0,0,1,.4-1.87A3.07,3.07,0,0,1,56.51,12a3.35,3.35,0,0,1,1.71-.44,2.61,2.61,0,0,1,2.28,1.11V9ZM60,16.59a2,2,0,0,0,.49-1.41,2,2,0,0,0-.49-1.4,1.74,1.74,0,0,0-2.54,0,2,2,0,0,0-.5,1.4,2,2,0,0,0,.5,1.41,1.74,1.74,0,0,0,2.54,0Z"/><path class="cls-3" d="M71,11.64V18a3.09,3.09,0,0,1-.47,1.73A3,3,0,0,1,69.2,20.9a4.53,4.53,0,0,1-2,.4,5.26,5.26,0,0,1-1.64-.25,5.32,5.32,0,0,1-1.42-.68L64.92,19a3.68,3.68,0,0,0,2.18.7,2.11,2.11,0,0,0,1.38-.42A1.43,1.43,0,0,0,69,18.09v-.8a2.24,2.24,0,0,1-.89.76,2.71,2.71,0,0,1-1.23.26,3.07,3.07,0,0,1-1.61-.42,2.86,2.86,0,0,1-1.08-1.2,3.89,3.89,0,0,1-.39-1.78,3.76,3.76,0,0,1,.39-1.75A2.84,2.84,0,0,1,65.26,12a3.07,3.07,0,0,1,1.61-.42,2.6,2.6,0,0,1,2.12,1v-.95Zm-2.46,4.64A1.88,1.88,0,0,0,69,15a1.88,1.88,0,0,0-.46-1.32,1.64,1.64,0,0,0-2.38,0A1.89,1.89,0,0,0,65.68,15a1.93,1.93,0,0,0,.46,1.32,1.68,1.68,0,0,0,2.39,0Z"/><path class="cls-3" d="M78.32,12.55a4,4,0,0,1,.88,2.74c0,.21,0,.37,0,.48h-5a1.84,1.84,0,0,0,.65,1.05,1.9,1.9,0,0,0,1.17.37,2.37,2.37,0,0,0,1-.19,2.54,2.54,0,0,0,.83-.56l1.06,1.08a3.5,3.5,0,0,1-1.31.92,4.44,4.44,0,0,1-1.7.32,4,4,0,0,1-2-.45,3.08,3.08,0,0,1-1.28-1.25,3.82,3.82,0,0,1-.45-1.88,3.88,3.88,0,0,1,.45-1.89A3.28,3.28,0,0,1,73.85,12a3.87,3.87,0,0,1,1.88-.45A3.32,3.32,0,0,1,78.32,12.55Zm-1,2a1.55,1.55,0,0,0-.44-1.11,1.5,1.5,0,0,0-1.11-.42,1.58,1.58,0,0,0-1.1.41,1.89,1.89,0,0,0-.55,1.12Z"/><path class="cls-3" d="M87,10.34a2.94,2.94,0,0,1,1,2.33,3.15,3.15,0,0,1-1,2.44,3.82,3.82,0,0,1-2.68.87h-2v2.7H80.55V9.51h3.76A4,4,0,0,1,87,10.34ZM85.75,14a1.58,1.58,0,0,0,.53-1.29,1.52,1.52,0,0,0-.53-1.26,2.51,2.51,0,0,0-1.53-.41H82.31v3.39h1.91A2.44,2.44,0,0,0,85.75,14Z"/><path class="cls-3" d="M91.86,12a2.86,2.86,0,0,1,1.42-.37v1.65a2.31,2.31,0,0,0-1.73.5,2,2,0,0,0-.65,1.54v3.38H89.2v-7h1.7V13A2.62,2.62,0,0,1,91.86,12Z"/><path class="cls-3" d="M99.33,12.07a3.17,3.17,0,0,1,1.29,1.25,3.63,3.63,0,0,1,.47,1.85,3.68,3.68,0,0,1-.47,1.87,3.19,3.19,0,0,1-1.29,1.26,4.36,4.36,0,0,1-3.86,0A3.16,3.16,0,0,1,94.17,17a3.68,3.68,0,0,1-.47-1.87,3.63,3.63,0,0,1,.47-1.85,3.13,3.13,0,0,1,1.3-1.25,4.36,4.36,0,0,1,3.86,0ZM96,13.67a2.13,2.13,0,0,0-.55,1.53A2.13,2.13,0,0,0,96,16.73a1.87,1.87,0,0,0,1.44.59,1.85,1.85,0,0,0,1.41-.59,2.13,2.13,0,0,0,.55-1.53,2.13,2.13,0,0,0-.55-1.53,1.81,1.81,0,0,0-1.41-.59A1.84,1.84,0,0,0,96,13.67Z"/><path class="cls-3" d="M108.3,12.07a3,3,0,0,1,1.16,1.27,4,4,0,0,1,.42,1.87,4,4,0,0,1-.41,1.85,3,3,0,0,1-1.15,1.24,3.31,3.31,0,0,1-1.73.45,3.09,3.09,0,0,1-1.39-.31,2.59,2.59,0,0,1-1-.9v3.68H102.5V11.67h1.71v1.16a2.46,2.46,0,0,1,1-.9,2.92,2.92,0,0,1,1.38-.31A3.32,3.32,0,0,1,108.3,12.07Zm-.7,4.61a2.16,2.16,0,0,0,.55-1.52,2.16,2.16,0,0,0-.55-1.52,2,2,0,0,0-2.84,0,2.12,2.12,0,0,0-.55,1.52,2.13,2.13,0,0,0,.55,1.53,2,2,0,0,0,2.84,0Z"/></svg>`)
                } else {
                  watermark = new Buffer(`<svg id="Layer_1" data-name="Layer 1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 340 140"><defs><style>.cls-1{fill:#fff;opacity:0.75;}.cls-2{font-size:14px;font-family:'OpenSans-Bold, Open Sans';font-weight:700;text-anchor: end;}</style></defs><rect class="cls-1" width="340" height="40.47"/><text class="cls-2" transform="translate(329.29 25.75)">${name}</text><image width="200" height="51" transform="translate(9.4 9.58) scale(0.42)" xlink:href="data:image/png;base64,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"/></svg>`)  
                }
                if (imageMetadata.width > 340 || (imageMetadata.width > 150 && style === 'cute')) {
                    const params = [{ ...options, input: watermark }];
                    image.composite(params);
                }
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
