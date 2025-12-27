
import unzipper from 'unzipper';
import { workerData, parentPort } from 'worker_threads';
import { readFile, writeFile, mkdir } from 'fs/promises';
import fs from 'fs/promises';
import fsSync from 'fs';       // <-- synchronous API
import _ from 'lodash';
import path from 'path';
import { XMLParser } from "fast-xml-parser";
import { execFileSync  } from 'child_process';
import { randomUUID } from 'crypto';

function getGcodeInformationFromHeaders(content)
{
	const lines = content.split('\n');
	const response = {weight: 0, estimated_time: 0};
	
	let time_found 		= false;
	let weight_found 	= false;
	
	_.each(lines, (line, index) => {
		if(line.includes('total estimated time'))
		{
			const time_in_text = line.split('total estimated time: ')[1];
			
			response.estimated_time = convertToSeconds(time_in_text);
			
			time_found = true;
		}
		
		if(line.includes('weight'))
		{
			const weight_in_text = line.split(':')[1]; 
			
			response.weight = sumWeightValues(weight_in_text);
			
			weight_found = true;
		}
		
		// found both data already, no need to continue to read all lines
		if(time_found && weight_found)
			return false; // break;
		
		
		// usually the normal gcode is already started here
		if(index > 200)
			return false;
	});
	
	return response;
}

function getGcodeInformationFromContent(content)
{
	const lines = content.split('\n');

	let totalExtruded = 0;
	let isRelativeMode = false;
	let lastE = null; // Add this at the top

	let lastX = null, lastY = null, lastZ = null, lastF = 1500;
	let prevX = null, prevY = null, prevZ = null;
	let totalTimeSeconds = 0;

	let loadTime = 0;
	let unloadTime = 0;
	let toolChanges = 0;
	let currentTool = null;

	for (let line of lines) {

		if (line.startsWith(';')) {
			// Parse machine config times
			const loadMatch = line.match(/machine_load_filament_time\s*=\s*(\d+)/);
			const unloadMatch = line.match(/machine_unload_filament_time\s*=\s*(\d+)/);

			if (loadMatch)
				loadTime = parseInt(loadMatch[1]);

			if (unloadMatch)
				unloadTime = parseInt(unloadMatch[1]);

			continue;
		}

		if (!line.trim())
			continue;
		
		// Detect extrusion mode
		if (line.includes('M83'))
			isRelativeMode = true;
		else if (line.includes('M82'))
			isRelativeMode = false;

		// Detect tool change
		const toolMatch = line.match(/^T(\d+)/);
		if (toolMatch) {
			const tool = parseInt(toolMatch[1]);

			if (tool !== currentTool) {
				currentTool = tool;
				toolChanges++;
			}
		}

		const isMovement = /^G[0-3]/.test(line);

		if (isMovement) {
			const x = parseFloat((line.match(/\sX([-\d.]+)/) || [])[1]);
			const y = parseFloat((line.match(/\sY([-\d.]+)/) || [])[1]);
			const z = parseFloat((line.match(/\sZ([-\d.]+)/) || [])[1]);
			const f = parseFloat((line.match(/\sF([-\d.]+)/) || [])[1]);

			// Update previous position before overwriting
			prevX = lastX;
			prevY = lastY;
			prevZ = lastZ;

			if (!Number.isNaN(x)) lastX = x;
			if (!Number.isNaN(y)) lastY = y;
			if (!Number.isNaN(z)) lastZ = z;
			if (!Number.isNaN(f)) lastF = f;

			// Estimate time only when we have at least previous and current coords
			if (
				prevX !== null && prevY !== null && prevZ !== null &&
				lastX !== null && lastY !== null && lastZ !== null &&
				lastF !== null
			) {
				const dx = lastX - prevX;
				const dy = lastY - prevY;
				const dz = lastZ - prevZ;
				const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
				totalTimeSeconds += (distance / lastF) * 60;
			}
		}

		// Match G0/G1/G2/G3 lines with E values
		const match = line.match(/^G(?:0|1|2|3)[^;]*\sE([\-]?\d*\.?\d+)/);

		if (match) {
			const eVal = parseFloat(match[1]);

			if (isRelativeMode) {
				
				if (!Number.isNaN(eVal) && lastF)
					totalTimeSeconds += (eVal / lastF) * 60;

				totalExtruded += eVal;
			} else {
				if (lastE !== null && !Number.isNaN(eVal)) {
					const delta = eVal - lastE;

					if (delta > 0)
					{
						if (lastF)
							totalTimeSeconds += (delta / lastF) * 60;

						totalExtruded += delta; // Only count forward moves
					}
				}
				lastE = eVal;
			}
		}
	}
	
	const filamentDiameter = 1.75;
	const filamentDensity = 1.25;
	const radius = filamentDiameter / 2;
	const volumeMm3 = Math.PI * Math.pow(radius, 2) * totalExtruded; // in mm3
	const volumeCm3 = volumeMm3 / 1000;
	const weightGrams = volumeCm3 * filamentDensity;

	// Add color change time
	totalTimeSeconds += toolChanges * (loadTime + unloadTime);
	totalTimeSeconds += 360;// startup time

	return {
		length: parseFloat(totalExtruded.toFixed(2)),
		weight: parseFloat(weightGrams.toFixed(2)),
		estimated_time: _.ceil(totalTimeSeconds),
	};
}

function convertToSeconds(timeString) {
  const regex = /(\d+)h\s*(\d+)m\s*(\d+)s|(\d+)m\s*(\d+)s|(\d+)s/;
  const match = timeString.trim().match(regex);

  if (match) {
    let totalSeconds = 0;

    if (match[1] && match[2] && match[3]) {  // "Xh Ym Zs" format
      const hours = parseInt(match[1], 10);
      const minutes = parseInt(match[2], 10);
      const seconds = parseInt(match[3], 10);
      totalSeconds = (hours * 3600) + (minutes * 60) + seconds;
    } else if (match[4] && match[5]) {  // "Ym Zs" format
      const minutes = parseInt(match[4], 10);
      const seconds = parseInt(match[5], 10);
      totalSeconds = (minutes * 60) + seconds;
    } else if (match[6]) {  // "Xs" format
      const seconds = parseInt(match[6], 10);
      totalSeconds = seconds;
    }

    return totalSeconds;
  } else {
    throw new Error("Invalid time format. Expected 'Xh Ym Zs', 'Ym Zs', or 'Xs'.");
  }
}

function getDateAndTime() {
  const now = new Date();
  return now.toISOString().replace('T', ' ').substring(0, 19);
}

function sumWeightValues(valueString) {
  // Split the string by commas and parse the individual numbers
  const values = valueString.split(',').map(value => parseFloat(value.trim()));

  // Sum all the parsed values
  return parseFloat(values.reduce((sum, value) => sum + value, 0).toFixed(2));
}

function getSliceInfo(file_content)
{
	const response = {plate: -1, weight: 0, estimated_time: 0};
	
	if(!file_content || _.isEmpty(file_content))
		return response;
	
	const xml_file 	= new XMLParser({
		ignoreAttributes: 		false,
		attributeNamePrefix: 	"",
		allowBooleanAttributes: true,
		isArray: 				(name) => ["metadata", "object", "filament", "warning", "header_item"].includes(name)
	}).parse(file_content);
	
	if(!xml_file)
		return response;
	
	if(!xml_file.config)
		return response;
	
	if(!xml_file.config.plate)
		return response;
	
	const metadata = xml_file.config.plate.metadata;
	
	if(!metadata)
		return response;
	
	const properties = _.fromPairs(
		metadata.map(({ key, value }) => [key, value])
	);
	
	if(properties.index >= 0)
		response.plate = Number(properties.index);
	
	if(properties.prediction >= 0)
		response.estimated_time = Number(properties.prediction);
	
	if(properties.weight >= 0)
		response.weight = Number(properties.weight);
	
	return response;
}

function unzipFileToTemp(file_path)
{
	const guid 		= randomUUID();
    const outputDir = '/tmp/' + guid + '/';
	
    try {
		execFileSync(
			'7z',
			['x', file_path, `-o${outputDir}`, '-y', '-bb3'],
			{ stdio: 'inherit' }
		);
    } catch (err) {
        // Ignore errors because we expect CRC warnings / non-zero exit codes
        console.warn(`7z exited with status ${err.status}, continuing anyway`);
    }
	
	
    // Check if output directory exists and has files
    if (!fsSync.existsSync(outputDir)) {
        throw new Error(`Extraction failed: output directory "${outputDir}" was not created`);
    }
	
	const files = fsSync.readdirSync(outputDir);
	
    if (files.length === 0) {
        throw new Error(`Extraction failed: no files were extracted to "${outputDir}"`);
    }
	
    return outputDir;
}

function extractSliceInfoContent(tempDirectory)
{
	return fs.readFile(tempDirectory + 'Metadata/slice_info.config', 'utf-8');
}

// there is always only 1 gcode file in
function extractPlateGcodeContent(tempDirectory, plateIndex)
{
	return fs.readdir(tempDirectory + 'Metadata/').then((files) => {
		let lastGcodeFile = undefined;
		
		for (const file of files) {
			if(file.toLowerCase() == 'plate_' + plateIndex + '.gcode')
			{
				return fs.readFile(tempDirectory + '/Metadata/' + file, 'utf-8');
			}
			else if(file.toLowerCase().endsWith('.gcode'))
				lastGcodeFile = file;
		};
		
		if(lastGcodeFile)
			return fs.readFile(tempDirectory + '/Metadata/' + lastGcodeFile, 'utf-8');
		
		return null;
	});
}

function extractPlateImages(tempDirectory, plateIndex)
{
	const metadataDir = tempDirectory + 'Metadata/';
	
	return fs.readdir(metadataDir).then((files) => {
		// We want the normal plate first then the others in this roder
		const order = [
			`plate_${plateIndex}.png`,
			// `plate_${plateIndex}_small.png`,
			// `plate_no_light_${plateIndex}.png`,
			`top_${plateIndex}.png`,
			// `pick_${plateIndex}.png`
		];

		// return the list of files in the order we want or a empty array
		const readPromises = order
            .filter(name => files.includes(name))
            .map(name =>
                fs.readFile(path.join(metadataDir, name))
                  .then(buffer => {
                      if (buffer.length === 0) {
                          // skip empty files
                          return null;
                      }
                      return {
                          filename: name,
                          base64: buffer.toString('base64')
                      };
                  })
            );
			
		// Wait for all reads and convert array of [name, base64] pairs into an object
        return Promise.all(readPromises).then(results => results.filter(Boolean));
	});
}

try {
    try {
        console.log('worker initialized: ', workerData);
		
		// sometimes the file system lags behind and isn't ready for the file to be properly used
		// this happends usually when more then 1 printer is sending data
		// every worker index is delayed by 30 sec to give the others time to finish first
		setTimeout(() => {
			const tempDirectory = unzipFileToTemp(workerData.path);

			const finishRequest = (finished_response_data) => {
				extractPlateImages(tempDirectory, finished_response_data.plate).then(images => {
					if(!_.isEmpty(images))
					{
						finished_response_data.preview_image_base64 = images[0].base64;
						finished_response_data.available_images 	= images;
					}
					
					// we can't pay for something less then 1 gram, we need a minimum of 1
					if(finished_response_data.weight <= 1)
						finished_response_data.weight = 1;
					
					parentPort.postMessage({ status: true, ...finished_response_data });
				});
			}
			
			extractSliceInfoContent(tempDirectory).then(slice_info_content => {
				// lets get the response data from the slice info when available.
				const response_data 			= {plate: -1, weight: 0, estimated_time: 0};
				const slice_info_response_data 	= getSliceInfo(slice_info_content);
				
				// we can always assume to get the default response_data back from the function
				// just need to make sure its actually something else then default
				if(slice_info_response_data.plate >= 0)
					response_data.plate = slice_info_response_data.plate;
				if(slice_info_response_data.weight > 0)
					response_data.weight = slice_info_response_data.weight;
				if(slice_info_response_data.estimated_time > 0)
					response_data.estimated_time = slice_info_response_data.estimated_time;
				
				if(response_data.weight == 0 || response_data.estimated_time == 0)
				{
					extractPlateGcodeContent(tempDirectory, response_data.plate).then((file_content) => {
						const header_response_data = getGcodeInformationFromHeaders(file_content);
						
						// if we already got a weight or estimated time assume the slice_info is more correct
						if(response_data.weight == 0 && header_response_data.weight > 0)
							response_data.weight = header_response_data.weight;
						if(response_data.estimated_time == 0 && header_response_data.estimated_time > 0)
							response_data.estimated_time = header_response_data.estimated_time;
						
						if(response_data.weight == 0 || response_data.estimated_time == 0)
						{
							const content_response_data = getGcodeInformationFromContent(file_content);
							
							// if we already got a weight or estimated time assume that those values are more correct
							if(response_data.weight == 0 && content_response_data.weight > 0)
								response_data.weight = content_response_data.weight;
							if(response_data.estimated_time == 0 && content_response_data.estimated_time > 0)
								response_data.estimated_time = content_response_data.estimated_time;
						}
						
						finishRequest(response_data);
					});
				}
				else
					finishRequest(response_data);
			});
		}, (workerData.index * 30000) + 2000);
    } catch (error) {
		console.log(error);
        parentPort.postMessage({ status: false});
    }
} catch (err) {
    parentPort.postMessage({ error: err.message });
}