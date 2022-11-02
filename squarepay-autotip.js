/* squarepay-autotip.js   
This code is a utility script for buskers to automate a Square reader to keep listening for & accepting
the same payment amount perpetually over & over. Receipt will only flash on screen briefly (1000ms?) and then 1 green led will turn back on, 
signifying that the square reader is ready to accept the next payment of the same amount you preset. This eliminates the need for the lengthy, 
vibe-destroying & COSTLY interruptions to your performance every single time somebody wishes to make a donation via the Square Reader hardware.
Ex. 
Either leave the payment amount set to the default, 10 dollars, or else enter an amount from 1..100 and click the 'RUN' button to run the script...
Now, 1 GREEN LED stays lit forever, constantly ready to accept the next payment.  Upon each successful payment, receipt screen will be displayed
briefly while the green led blinks off & back on immediately, ready to accept the next identical payment value you preset.
To change preset payment amount: stop script -> enter new payment amount -> run script again.
/**/

package edu.cmu.square.proofofconcept;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileReader;
import java.io.IOException;

import edu.cmu.square.client.exceptions.SquareException;

public class SquareUtility
{

	public static void main(String[] args) 
	{
		//getReqProCSVFormat("c:\\importTest\\outpuImport.xml","c:\\importTest\\output.CSV");
		BufferedReader reader;
		try
		{
			reader = new BufferedReader(new FileReader(new File("c:\\importTest\\requirements.xml")));
			String SQUARE_XML =getContent(reader);
			
			reader = new BufferedReader(new FileReader(new File("c:\\importTest\\UC All Use Cases.CSV")));
			String ReqProCSV = getContent(reader);
			
			RequisiteProTransformations tranformer = new RequisiteProTransformations();
			
		  tranformer.transform_SquareXML_To_ReqProCSV(SQUARE_XML);
			tranformer.transform_SquareXML_Terms_To_ReqProCSV(SQUARE_XML);
			tranformer.transform_ReqProCSV_To_SquareXML(ReqProCSV);
		}
		catch (FileNotFoundException e)
		{ // TODO Auto-generated catch block
			e.printStackTrace();
		}
		catch (SquareException e)
		{	// TODO Auto-generated catch block
			e.printStackTrace();
		}
	}
	
	
	public static String getContent(BufferedReader reader)
	{
		StringBuilder builder= new StringBuilder();
		String str;
		try {
				while ((str = reader.readLine()) != null) {	builder.append(str+"\n");  }
				reader.close();
		}
		catch (IOException e) { // TODO Auto-generated catch block
				e.printStackTrace();
		}
		return builder.toString();
	}


}
