
import unzipper from 'unzipper';
import { workerData, parentPort } from 'worker_threads';
import { readFile } from 'fs/promises';
import _ from 'lodash';

function extractPlateGcode(filePath)
{
	console.log('extractPlateGcode', filePath);
	
    return unzipper.Open.file(filePath).then((directory) => {
		const file = directory.files.find(file =>
			file.path.startsWith('Metadata/plate_') && file.path.endsWith('.gcode')
		);
		
		if (!file)
			throw new Error('plate_1.gcode not found')
		
		return file.buffer();
	}).then((content) => {
		return content.toString('utf8');
	});
}

function getGcodeInformationFromHeaders(content)
{
	const lines = content.split('\n');
	const response = {weight: 0, estimated_time: 0};
	
	let time_found = false;
	let weight_found = false;
	
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
	
	// in case the file is just too small, like a simple circle
	if(response.weight <= 1 && response.estimated_time > 0)
		response.weight = 1;
	
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



try {
    try {
        console.log('worker initialized');
		extractPlateGcode(workerData).then((file_content) => {
			let response_data = getGcodeInformationFromHeaders(file_content);
			
			if(response_data.weight < 5 && response_data.estimated_time < 5)
			{
				response_data = getGcodeInformationFromContent(file_content);
				response_data.parsed_by = 'content';
			}
			else
				response_data.parsed_by = 'headers';
			
			parentPort.postMessage({ status: true, ...response_data });
		})
    } catch (error) {
		console.log(error);
        parentPort.postMessage({ status: false});
    }
} catch (err) {
    parentPort.postMessage({ error: err.message });
}
